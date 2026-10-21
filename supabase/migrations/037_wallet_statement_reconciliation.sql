-- Extrato da conta do Mercado Pago e conciliacao de Pix recebidos com as
-- parcelas das despesas. Usa apenas recursos gratuitos: o relatorio de
-- liberacoes (ja baixado para calcular o saldo) e a consulta de pagamentos.
-- Rode depois da 036_granular_access_control.sql.

-- ============================================================
-- 1) Identificacao do pagador por morador
-- ============================================================
-- E-mails ou CPFs (somente digitos) com que o morador costuma pagar. Servem
-- para sugerir automaticamente a quem pertence cada Pix recebido.
alter table public.household_members
  add column if not exists payer_identifiers text[] not null default array[]::text[];

-- ============================================================
-- 2) Movimentacoes do relatorio
-- ============================================================
create table if not exists public.wallet_movements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  -- Relatorios diarios cobrem 35 dias e se sobrepoem; a chave identifica a
  -- mesma linha em relatorios diferentes para nao duplicar o extrato.
  movement_key text not null,
  source_id text,
  occurred_at timestamptz not null,
  record_type text,
  description text,
  payment_method text,
  net_credit numeric(12,2) not null default 0 check (net_credit >= 0),
  net_debit numeric(12,2) not null default 0 check (net_debit >= 0),
  balance_after numeric(12,2),
  payer_name text,
  payer_email text,
  payer_document text,
  payer_lookup_status text not null default 'pending'
    check (payer_lookup_status in ('pending', 'found', 'unavailable', 'skipped')),
  ignored boolean not null default false,
  report_file text,
  created_at timestamptz not null default now(),
  unique (household_id, movement_key)
);

create index if not exists wallet_movements_household_date_idx
  on public.wallet_movements(household_id, occurred_at desc);

-- Um Pix pode quitar varias parcelas; cada parcela e conciliada uma vez.
create table if not exists public.wallet_movement_shares (
  movement_id uuid not null references public.wallet_movements(id) on delete cascade,
  share_id uuid not null references public.expense_shares(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  reconciled_by uuid references auth.users(id) on delete set null,
  reconciled_at timestamptz not null default now(),
  primary key (movement_id, share_id),
  unique (share_id)
);

alter table public.wallet_movements enable row level security;
alter table public.wallet_movement_shares enable row level security;

drop policy if exists wallet_movements_read on public.wallet_movements;
create policy wallet_movements_read on public.wallet_movements
for select to authenticated
using (household_id = public.current_household_id()
  and public.has_permission('view_wallet_balance'));

-- A sincronizacao manual roda com o usuario logado (manage_wallet); o cron
-- usa a service role.
drop policy if exists wallet_movements_manage on public.wallet_movements;
create policy wallet_movements_manage on public.wallet_movements
for all to authenticated
using (household_id = public.current_household_id()
  and public.has_permission('manage_wallet'))
with check (household_id = public.current_household_id()
  and public.has_permission('manage_wallet'));

drop policy if exists wallet_movement_shares_read on public.wallet_movement_shares;
create policy wallet_movement_shares_read on public.wallet_movement_shares
for select to authenticated
using (exists (
  select 1 from public.wallet_movements movement
  where movement.id = movement_id
    and movement.household_id = public.current_household_id()
    and public.has_permission('view_wallet_balance')
));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.wallet_movements from anon;
    revoke all on table public.wallet_movement_shares from anon;
  end if;
end;
$$;

-- Vinculos so mudam pelas funcoes abaixo.
revoke all on table public.wallet_movement_shares from authenticated;
grant select on table public.wallet_movement_shares to authenticated;
revoke all on table public.wallet_movements from authenticated;
grant select, insert, update on table public.wallet_movements to authenticated;

-- ============================================================
-- 3) Pix conciliado vale como comprovante
-- ============================================================
-- Mesma regra da versao anterior, acrescentando: uma parcela vinculada a um
-- Pix do extrato pode ser marcada como paga sem anexo.
create or replace function public.require_expense_receipt_before_paid()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  acting_is_admin boolean := false;
  reconciled_by_statement boolean := false;
begin
  select exists (
    select 1
    from public.profiles profile
    join public.expenses expense on expense.id = new.expense_id
    where profile.id = auth.uid()
      and profile.status = 'active'
      and public.has_permission('record_payments_without_receipt')
      and profile.household_id = expense.household_id
  ) into acting_is_admin;

  select exists (
    select 1 from public.wallet_movement_shares link
    where link.share_id = new.id
  ) into reconciled_by_statement;

  if new.payment_status = 'paid'::public.share_status then
    if nullif(btrim(new.receipt_path), '') is null
      and not acting_is_admin
      and not reconciled_by_statement then
      raise exception 'Anexe o comprovante antes de marcar esta parcela como paga.';
    end if;

    if new.paid_amount is null and new.receipt_path is not null then
      new.paid_amount := new.amount;
    end if;
    if new.paid_amount is null or new.paid_amount <= 0 then
      raise exception 'Informe um valor pago maior que zero.';
    end if;
    if new.paid_amount > new.amount then
      raise exception 'O valor pago não pode ultrapassar o valor da parcela.';
    end if;
    if not acting_is_admin
      and not reconciled_by_statement
      and new.paid_amount is distinct from new.amount then
      raise exception 'Voce nao tem permissao para alterar o valor efetivamente pago.';
    end if;
  else
    new.paid_amount := null;
    new.payment_recorded_by := null;
  end if;

  return new;
end;
$function$;

-- Recalcula o status da despesa como set_expense_share_payment faz.
create or replace function public.refresh_expense_status(target_expense_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.expenses expense
  set status = case
    when expense.amount is null then 'planned'::public.expense_status
    when exists (
      select 1 from public.expense_shares share_row
      where share_row.expense_id = target_expense_id
    ) and not exists (
      select 1 from public.expense_shares share_row
      where share_row.expense_id = target_expense_id
        and share_row.payment_status not in (
          'paid'::public.share_status,
          'waived'::public.share_status
        )
    ) then 'paid'::public.expense_status
    else 'open'::public.expense_status
  end
  where expense.id = target_expense_id;
$$;

revoke all on function public.refresh_expense_status(uuid) from public;

-- ============================================================
-- 4) Conciliar e desfazer
-- ============================================================
create or replace function public.reconcile_wallet_movement(
  target_movement_id uuid,
  target_share_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  target_movement public.wallet_movements%rowtype;
  already_linked numeric(12,2);
  selected_total numeric(12,2);
  selected_count integer;
  share_row record;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null or not public.has_permission('manage_wallet') then
    raise exception 'Voce nao tem permissao para conciliar a conta.';
  end if;
  if coalesce(cardinality(target_share_ids), 0) = 0 then
    raise exception 'Selecione ao menos uma parcela.';
  end if;

  -- Mesmo lock de casa usado pelos rodizios: serializa conciliacoes.
  perform 1 from public.households household
  where household.id = acting_profile.household_id
  for update;

  select * into target_movement
  from public.wallet_movements movement
  where movement.id = target_movement_id
    and movement.household_id = acting_profile.household_id
  for update;

  if target_movement.id is null then
    raise exception 'Movimentacao nao encontrada.';
  end if;
  if target_movement.net_credit <= 0 then
    raise exception 'Somente entradas podem ser conciliadas com parcelas.';
  end if;
  if target_movement.ignored then
    raise exception 'Esta movimentacao foi marcada como ignorada.';
  end if;

  select count(*), coalesce(sum(share.amount), 0)
    into selected_count, selected_total
  from public.expense_shares share
  join public.expenses expense on expense.id = share.expense_id
  where share.id = any(target_share_ids)
    and expense.household_id = acting_profile.household_id
    and share.payment_status in ('pending'::public.share_status, 'late'::public.share_status)
    and share.amount > 0
    and not exists (
      select 1 from public.wallet_movement_shares link where link.share_id = share.id
    );

  if selected_count <> (select count(distinct id) from unnest(target_share_ids) as provided(id)) then
    raise exception 'Alguma parcela selecionada ja foi paga, conciliada ou nao pertence a casa. Atualize a pagina.';
  end if;

  select coalesce(sum(link.amount), 0) into already_linked
  from public.wallet_movement_shares link
  where link.movement_id = target_movement.id;

  if already_linked + selected_total > target_movement.net_credit then
    raise exception 'As parcelas somam % e o Pix disponivel para conciliar e %.',
      to_char(selected_total, 'FM999G999G990D00'),
      to_char(target_movement.net_credit - already_linked, 'FM999G999G990D00');
  end if;

  for share_row in
    select share.id, share.amount, share.expense_id
    from public.expense_shares share
    where share.id = any(target_share_ids)
    order by share.expense_id, share.id
  loop
    perform 1 from public.expenses expense
    where expense.id = share_row.expense_id
    for update;

    -- O vinculo vem antes do update para o trigger aceitar o Pix como comprovante.
    insert into public.wallet_movement_shares (movement_id, share_id, amount, reconciled_by)
    values (target_movement.id, share_row.id, share_row.amount, acting_profile.id);

    update public.expense_shares
    set payment_status = 'paid'::public.share_status,
        paid_amount = share_row.amount,
        paid_at = target_movement.occurred_at,
        payment_method = 'Pix conciliado (Mercado Pago)',
        payment_recorded_by = acting_profile.id
    where id = share_row.id;

    perform public.refresh_expense_status(share_row.expense_id);
  end loop;

  return selected_count;
end;
$$;

revoke all on function public.reconcile_wallet_movement(uuid, uuid[]) from public;
grant execute on function public.reconcile_wallet_movement(uuid, uuid[]) to authenticated;

-- Desfaz a conciliacao de uma movimentacao: as parcelas voltam a pendentes
-- (ou atrasadas, se vencidas) e o vinculo e removido.
create or replace function public.undo_wallet_reconciliation(target_movement_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  link_row record;
  undone integer := 0;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null or not public.has_permission('manage_wallet') then
    raise exception 'Voce nao tem permissao para conciliar a conta.';
  end if;

  perform 1 from public.households household
  where household.id = acting_profile.household_id
  for update;

  if not exists (
    select 1 from public.wallet_movements movement
    where movement.id = target_movement_id
      and movement.household_id = acting_profile.household_id
  ) then
    raise exception 'Movimentacao nao encontrada.';
  end if;

  for link_row in
    select link.share_id, share.expense_id, expense.due_date
    from public.wallet_movement_shares link
    join public.expense_shares share on share.id = link.share_id
    join public.expenses expense on expense.id = share.expense_id
    where link.movement_id = target_movement_id
    order by share.expense_id, link.share_id
  loop
    perform 1 from public.expenses expense
    where expense.id = link_row.expense_id
    for update;

    delete from public.wallet_movement_shares
    where movement_id = target_movement_id
      and share_id = link_row.share_id;

    -- Somente parcelas pagas pela conciliacao voltam; se alguem alterou o
    -- pagamento depois, a parcela fica como esta.
    update public.expense_shares
    set payment_status = case
          when link_row.due_date is not null
            and link_row.due_date < (now() at time zone 'America/Sao_Paulo')::date
            then 'late'::public.share_status
          else 'pending'::public.share_status
        end,
        paid_at = null,
        payment_method = null
    where id = link_row.share_id
      and payment_method = 'Pix conciliado (Mercado Pago)';

    perform public.refresh_expense_status(link_row.expense_id);
    undone := undone + 1;
  end loop;

  return undone;
end;
$$;

revoke all on function public.undo_wallet_reconciliation(uuid) from public;
grant execute on function public.undo_wallet_reconciliation(uuid) to authenticated;
