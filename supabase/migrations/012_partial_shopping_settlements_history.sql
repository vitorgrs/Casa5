-- Casa Cinco — pagamentos parciais e histórico dos acertos de compras.
-- Rode depois da 011_admin_manage_all_shopping_settlements.sql.

-- Cada parcela mantém o valor original e passa a registrar quanto já foi
-- efetivamente compensado ou pago. Isso permite deixar apenas o saldo em aberto.
alter table public.shopping_purchase_shares
  add column if not exists settled_amount numeric(12,2) not null default 0
    check (settled_amount >= 0 and settled_amount <= amount);

update public.shopping_purchase_shares share
set settled_amount = share.amount
from public.shopping_purchases purchase
where purchase.id = share.purchase_id
  and share.payment_status = 'paid'::public.share_status
  and share.member_id <> purchase.paid_by_member_id
  and share.settled_amount = 0;

create table if not exists public.shopping_settlement_payments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  debtor_member_id uuid not null references public.household_members(id) on delete restrict,
  creditor_member_id uuid not null references public.household_members(id) on delete restrict,
  target_share_id uuid references public.shopping_purchase_shares(id) on delete set null,
  amount numeric(12,2) not null check (amount >= 0),
  payment_kind text not null default 'pix' check (payment_kind in ('pix', 'compensation')),
  status text not null default 'pending' check (status in ('pending', 'confirmed')),
  receipt_path text unique,
  receipt_name text,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz not null default now(),
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (debtor_member_id <> creditor_member_id),
  check (
    (payment_kind = 'pix' and amount > 0 and receipt_path is not null)
    or (payment_kind = 'compensation' and amount = 0)
  )
);

create index if not exists shopping_settlement_payments_household_idx
  on public.shopping_settlement_payments(household_id, status, submitted_at desc);
create index if not exists shopping_settlement_payments_members_idx
  on public.shopping_settlement_payments(debtor_member_id, creditor_member_id, status);

drop trigger if exists shopping_settlement_payments_updated_at
  on public.shopping_settlement_payments;
create trigger shopping_settlement_payments_updated_at
before update on public.shopping_settlement_payments
for each row execute procedure public.set_updated_at();

alter table public.shopping_settlement_payments enable row level security;

drop policy if exists shopping_settlement_payments_read
  on public.shopping_settlement_payments;
create policy shopping_settlement_payments_read
on public.shopping_settlement_payments for select to authenticated
using (
  household_id = public.current_household_id()
  and (
    public.is_house_admin(household_id)
    or debtor_member_id = (
      select member_id from public.profiles where id = auth.uid()
    )
    or creditor_member_id = (
      select member_id from public.profiles where id = auth.uid()
    )
  )
);

-- Depois que qualquer parte da parcela foi liquidada, seu valor original não
-- pode ser recalculado ou apagado, pois isso quebraria o histórico financeiro.
create or replace function public.protect_settled_shopping_share()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
    and new.amount is distinct from old.amount
    and old.settled_amount > 0 then
    raise exception 'Não é possível alterar uma compra que já possui pagamento confirmado.';
  end if;
  if tg_op = 'DELETE' and old.settled_amount > 0 then
    raise exception 'Não é possível excluir uma compra que já possui pagamento confirmado.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_settled_shopping_share
  on public.shopping_purchase_shares;
create trigger protect_settled_shopping_share
before update of amount or delete on public.shopping_purchase_shares
for each row execute procedure public.protect_settled_shopping_share();

-- Recupera comprovantes antigos como registros de histórico. Para comprovantes
-- ainda pendentes, o valor é o saldo líquido atual. Para os já confirmados,
-- usa o valor líquido que foi encerrado no mesmo instante.
do $$
declare
  proof record;
  gross_outgoing numeric(12,2);
  gross_incoming numeric(12,2);
  recovered_amount numeric(12,2);
  recovered_status text;
  recovered_confirmed_at timestamptz;
begin
  for proof in
    select distinct on (s.receipt_path)
      s.id as target_share_id,
      s.member_id as debtor_member_id,
      p.paid_by_member_id as creditor_member_id,
      p.household_id,
      s.receipt_path,
      s.receipt_name,
      s.receipt_uploaded_by,
      s.receipt_uploaded_at,
      s.payment_status,
      s.paid_at
    from public.shopping_purchase_shares s
    join public.shopping_purchases p on p.id = s.purchase_id
    where s.receipt_path is not null
    order by s.receipt_path, s.receipt_uploaded_at nulls last, s.id
  loop
    if proof.payment_status = 'pending'::public.share_status then
      select coalesce(sum(s.amount - s.settled_amount), 0)
        into gross_outgoing
      from public.shopping_purchase_shares s
      join public.shopping_purchases p on p.id = s.purchase_id
      where s.member_id = proof.debtor_member_id
        and p.paid_by_member_id = proof.creditor_member_id
        and p.household_id = proof.household_id
        and s.payment_status = 'pending'::public.share_status
        and s.created_at <= coalesce(proof.receipt_uploaded_at, now());

      select coalesce(sum(s.amount - s.settled_amount), 0)
        into gross_incoming
      from public.shopping_purchase_shares s
      join public.shopping_purchases p on p.id = s.purchase_id
      where s.member_id = proof.creditor_member_id
        and p.paid_by_member_id = proof.debtor_member_id
        and p.household_id = proof.household_id
        and s.payment_status = 'pending'::public.share_status
        and s.created_at <= coalesce(proof.receipt_uploaded_at, now());

      recovered_amount := greatest(round(gross_outgoing - gross_incoming, 2), 0);
      recovered_status := 'pending';
      recovered_confirmed_at := null;
    else
      select coalesce(sum(s.amount), 0)
        into gross_outgoing
      from public.shopping_purchase_shares s
      join public.shopping_purchases p on p.id = s.purchase_id
      where s.receipt_path = proof.receipt_path
        and s.member_id = proof.debtor_member_id
        and p.paid_by_member_id = proof.creditor_member_id
        and p.household_id = proof.household_id;

      select coalesce(sum(s.amount), 0)
        into gross_incoming
      from public.shopping_purchase_shares s
      join public.shopping_purchases p on p.id = s.purchase_id
      where s.member_id = proof.creditor_member_id
        and p.paid_by_member_id = proof.debtor_member_id
        and p.household_id = proof.household_id
        and s.payment_status = 'paid'::public.share_status
        and s.paid_at = proof.paid_at;

      recovered_amount := greatest(round(gross_outgoing - gross_incoming, 2), 0);
      if recovered_amount = 0 then
        recovered_amount := round(gross_outgoing, 2);
      end if;
      recovered_status := 'confirmed';
      recovered_confirmed_at := proof.paid_at;
    end if;

    if recovered_amount > 0 then
      insert into public.shopping_settlement_payments (
        household_id, debtor_member_id, creditor_member_id, target_share_id,
        amount, payment_kind, status, receipt_path, receipt_name,
        submitted_by, submitted_at, confirmed_at
      ) values (
        proof.household_id, proof.debtor_member_id, proof.creditor_member_id,
        proof.target_share_id, recovered_amount, 'pix', recovered_status,
        proof.receipt_path, proof.receipt_name, proof.receipt_uploaded_by,
        coalesce(proof.receipt_uploaded_at, proof.paid_at, now()),
        recovered_confirmed_at
      )
      on conflict (receipt_path) do nothing;
    end if;
  end loop;
end;
$$;

-- Os comprovantes recuperados passam a viver no histórico. Remove as cópias
-- legadas das parcelas para elas não bloquearem o próximo pagamento parcial.
update public.shopping_purchase_shares share
set receipt_path = null,
    receipt_name = null,
    receipt_uploaded_by = null,
    receipt_uploaded_at = null
where share.receipt_path is not null
  and exists (
    select 1
    from public.shopping_settlement_payments payment
    where payment.receipt_path = share.receipt_path
  );

-- Aplica um valor, em centavos, às parcelas abertas de uma direção. A função
-- é interna e só é chamada pelas rotinas protegidas abaixo.
create or replace function public.apply_shopping_settlement_amount(
  target_household_id uuid,
  target_debtor_member_id uuid,
  target_creditor_member_id uuid,
  amount_cents bigint,
  settlement_cutoff timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  share_row record;
  remaining_cents bigint := amount_cents;
  available_cents bigint;
  applied_cents bigint;
  new_settled numeric(12,2);
begin
  if amount_cents < 0 then
    raise exception 'Valor de baixa inválido.';
  end if;

  for share_row in
    select s.id, s.amount, s.settled_amount
    from public.shopping_purchase_shares s
    join public.shopping_purchases p on p.id = s.purchase_id
    where s.member_id = target_debtor_member_id
      and p.paid_by_member_id = target_creditor_member_id
      and p.household_id = target_household_id
      and s.payment_status = 'pending'::public.share_status
      and s.created_at <= settlement_cutoff
    order by s.created_at, s.id
    for update of s
  loop
    exit when remaining_cents = 0;
    available_cents := round((share_row.amount - share_row.settled_amount) * 100)::bigint;
    applied_cents := least(available_cents, remaining_cents);
    new_settled := share_row.settled_amount + applied_cents / 100.0;

    update public.shopping_purchase_shares
    set settled_amount = new_settled,
        payment_status = case
          when new_settled >= amount then 'paid'::public.share_status
          else 'pending'::public.share_status
        end,
        paid_at = case when new_settled >= amount then now() else null end
    where id = share_row.id;

    remaining_cents := remaining_cents - applied_cents;
  end loop;

  if remaining_cents <> 0 then
    raise exception 'O valor informado ultrapassa o saldo em aberto.';
  end if;
end;
$$;

revoke all on function public.apply_shopping_settlement_amount(uuid, uuid, uuid, bigint, timestamptz) from public;
revoke all on function public.apply_shopping_settlement_amount(uuid, uuid, uuid, bigint, timestamptz) from authenticated;

-- A assinatura antiga não recebe o valor pago e não pode continuar disponível.
drop function if exists public.submit_shopping_net_receipt(uuid, text, text);

create or replace function public.submit_shopping_net_receipt(
  target_share_id uuid,
  uploaded_path text,
  uploaded_name text,
  paid_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  debtor_member_id uuid;
  creditor_member_id uuid;
  target_household_id uuid;
  gross_outgoing_cents bigint;
  gross_incoming_cents bigint;
  net_cents bigint;
  paid_cents bigint;
  new_payment_id uuid;
begin
  select s.member_id, p.paid_by_member_id, p.household_id
    into debtor_member_id, creditor_member_id, target_household_id
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  join public.profiles profile on profile.id = auth.uid()
  where s.id = target_share_id
    and s.payment_status = 'pending'::public.share_status
    and s.amount > s.settled_amount
    and profile.status = 'active'
    and profile.household_id = p.household_id
    and (profile.member_id = s.member_id or profile.role = 'admin'::public.user_role)
    and s.member_id <> p.paid_by_member_id
  for update of s;

  if debtor_member_id is null then
    raise exception 'Dívida não encontrada ou sem permissão para enviar o comprovante.';
  end if;
  if uploaded_path not like target_household_id::text || '/shopping-net/' || target_share_id::text || '/%' then
    raise exception 'Caminho do comprovante inválido.';
  end if;

  paid_cents := round(paid_amount * 100)::bigint;
  if paid_amount is null or paid_cents <= 0 then
    raise exception 'Informe um valor pago maior que zero.';
  end if;

  if exists (
    select 1 from public.shopping_settlement_payments payment
    where payment.household_id = target_household_id
      and payment.status = 'pending'
      and (
        (payment.debtor_member_id = debtor_member_id and payment.creditor_member_id = creditor_member_id)
        or (payment.debtor_member_id = creditor_member_id and payment.creditor_member_id = debtor_member_id)
      )
  ) then
    raise exception 'Já existe um comprovante aguardando confirmação para este acerto.';
  end if;

  select coalesce(sum(round((s.amount - s.settled_amount) * 100)), 0)::bigint
    into gross_outgoing_cents
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = debtor_member_id
    and p.paid_by_member_id = creditor_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'::public.share_status;

  select coalesce(sum(round((s.amount - s.settled_amount) * 100)), 0)::bigint
    into gross_incoming_cents
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = creditor_member_id
    and p.paid_by_member_id = debtor_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'::public.share_status;

  net_cents := gross_outgoing_cents - gross_incoming_cents;
  if net_cents <= 0 then
    raise exception 'Após a compensação, esta pessoa não possui saldo a pagar.';
  end if;
  if paid_cents > net_cents then
    raise exception 'O valor pago não pode ultrapassar o saldo líquido em aberto.';
  end if;

  insert into public.shopping_settlement_payments (
    household_id, debtor_member_id, creditor_member_id, target_share_id,
    amount, payment_kind, status, receipt_path, receipt_name,
    submitted_by, submitted_at
  ) values (
    target_household_id, debtor_member_id, creditor_member_id, target_share_id,
    paid_cents / 100.0, 'pix', 'pending', uploaded_path, uploaded_name,
    auth.uid(), now()
  ) returning id into new_payment_id;

  update public.shopping_purchase_shares
  set receipt_path = uploaded_path,
      receipt_name = uploaded_name,
      receipt_uploaded_by = auth.uid(),
      receipt_uploaded_at = now()
  where id = target_share_id;

  return new_payment_id;
end;
$$;

revoke all on function public.submit_shopping_net_receipt(uuid, text, text, numeric) from public;
grant execute on function public.submit_shopping_net_receipt(uuid, text, text, numeric) to authenticated;

drop function if exists public.confirm_shopping_net_payment(uuid);

create function public.confirm_shopping_net_payment(target_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_row public.shopping_settlement_payments%rowtype;
  gross_outgoing_cents bigint;
  gross_incoming_cents bigint;
  reciprocal_cents bigint;
  paid_cents bigint;
begin
  select payment.* into payment_row
  from public.shopping_settlement_payments payment
  join public.profiles profile on profile.id = auth.uid()
  where payment.id = target_payment_id
    and payment.status = 'pending'
    and payment.payment_kind = 'pix'
    and payment.receipt_path is not null
    and profile.status = 'active'
    and profile.household_id = payment.household_id
    and (
      profile.member_id = payment.creditor_member_id
      or profile.role = 'admin'::public.user_role
    )
  for update of payment;

  if payment_row.id is null then
    raise exception 'Pagamento sem comprovante, já confirmado ou sem permissão.';
  end if;

  select coalesce(sum(round((s.amount - s.settled_amount) * 100)), 0)::bigint
    into gross_outgoing_cents
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = payment_row.debtor_member_id
    and p.paid_by_member_id = payment_row.creditor_member_id
    and p.household_id = payment_row.household_id
    and s.payment_status = 'pending'::public.share_status
    and s.created_at <= payment_row.submitted_at;

  select coalesce(sum(round((s.amount - s.settled_amount) * 100)), 0)::bigint
    into gross_incoming_cents
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = payment_row.creditor_member_id
    and p.paid_by_member_id = payment_row.debtor_member_id
    and p.household_id = payment_row.household_id
    and s.payment_status = 'pending'::public.share_status
    and s.created_at <= payment_row.submitted_at;

  paid_cents := round(payment_row.amount * 100)::bigint;
  if gross_outgoing_cents - gross_incoming_cents < paid_cents then
    raise exception 'O saldo atual é menor que o valor informado neste comprovante.';
  end if;

  reciprocal_cents := least(gross_outgoing_cents, gross_incoming_cents);
  perform public.apply_shopping_settlement_amount(
    payment_row.household_id,
    payment_row.debtor_member_id,
    payment_row.creditor_member_id,
    reciprocal_cents + paid_cents,
    payment_row.submitted_at
  );
  perform public.apply_shopping_settlement_amount(
    payment_row.household_id,
    payment_row.creditor_member_id,
    payment_row.debtor_member_id,
    reciprocal_cents,
    payment_row.submitted_at
  );

  update public.shopping_settlement_payments
  set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now()
  where id = payment_row.id;

  -- O histórico passa a ser a fonte do comprovante. Limpar a parcela permite
  -- que outro pagamento parcial seja enviado para o saldo que ainda restar.
  update public.shopping_purchase_shares
  set receipt_path = null,
      receipt_name = null,
      receipt_uploaded_by = null,
      receipt_uploaded_at = null
  where id = payment_row.target_share_id;
end;
$$;

revoke all on function public.confirm_shopping_net_payment(uuid) from public;
grant execute on function public.confirm_shopping_net_payment(uuid) to authenticated;

-- Registra também as quitações sem PIX para que apareçam em “Fechados”.
create or replace function public.settle_zero_shopping_balance(counterparty_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_member_id uuid;
  target_household_id uuid;
  gross_outgoing_cents bigint;
  gross_incoming_cents bigint;
  reciprocal_cents bigint;
begin
  select member_id, household_id into current_member_id, target_household_id
  from public.profiles
  where id = auth.uid() and status = 'active';

  select coalesce(sum(round((s.amount - s.settled_amount) * 100)), 0)::bigint
    into gross_outgoing_cents
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = current_member_id
    and p.paid_by_member_id = counterparty_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'::public.share_status;

  select coalesce(sum(round((s.amount - s.settled_amount) * 100)), 0)::bigint
    into gross_incoming_cents
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = counterparty_member_id
    and p.paid_by_member_id = current_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'::public.share_status;

  if gross_outgoing_cents = 0 or gross_outgoing_cents <> gross_incoming_cents then
    raise exception 'As dívidas não possuem o mesmo valor para quitação por compensação.';
  end if;
  reciprocal_cents := gross_outgoing_cents;

  insert into public.shopping_settlement_payments (
    household_id, debtor_member_id, creditor_member_id, amount,
    payment_kind, status, submitted_by, submitted_at, confirmed_by, confirmed_at
  ) values (
    target_household_id, current_member_id, counterparty_member_id, 0,
    'compensation', 'confirmed', auth.uid(), now(), auth.uid(), now()
  );

  perform public.apply_shopping_settlement_amount(
    target_household_id, current_member_id, counterparty_member_id,
    reciprocal_cents, now()
  );
  perform public.apply_shopping_settlement_amount(
    target_household_id, counterparty_member_id, current_member_id,
    reciprocal_cents, now()
  );
end;
$$;

revoke all on function public.settle_zero_shopping_balance(uuid) from public;
grant execute on function public.settle_zero_shopping_balance(uuid) to authenticated;

create or replace function public.settle_zero_shopping_balance_as_admin(
  first_member_id uuid,
  second_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_household_id uuid;
  valid_member_count integer;
  first_owes_second_cents bigint;
  second_owes_first_cents bigint;
begin
  if first_member_id = second_member_id then
    raise exception 'Informe dois moradores diferentes.';
  end if;

  select household_id into target_household_id
  from public.profiles
  where id = auth.uid() and status = 'active' and role = 'admin'::public.user_role;
  if target_household_id is null then
    raise exception 'Somente o administrador pode quitar acertos de outros moradores.';
  end if;

  select count(*) into valid_member_count
  from public.household_members
  where household_id = target_household_id
    and active = true
    and id in (first_member_id, second_member_id);
  if valid_member_count <> 2 then
    raise exception 'Um dos moradores não pertence a esta casa.';
  end if;

  select coalesce(sum(round((s.amount - s.settled_amount) * 100)), 0)::bigint
    into first_owes_second_cents
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = first_member_id
    and p.paid_by_member_id = second_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'::public.share_status;

  select coalesce(sum(round((s.amount - s.settled_amount) * 100)), 0)::bigint
    into second_owes_first_cents
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = second_member_id
    and p.paid_by_member_id = first_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'::public.share_status;

  if first_owes_second_cents = 0 or first_owes_second_cents <> second_owes_first_cents then
    raise exception 'As dívidas não possuem o mesmo valor para quitação por compensação.';
  end if;

  insert into public.shopping_settlement_payments (
    household_id, debtor_member_id, creditor_member_id, amount,
    payment_kind, status, submitted_by, submitted_at, confirmed_by, confirmed_at
  ) values (
    target_household_id, first_member_id, second_member_id, 0,
    'compensation', 'confirmed', auth.uid(), now(), auth.uid(), now()
  );

  perform public.apply_shopping_settlement_amount(
    target_household_id, first_member_id, second_member_id,
    first_owes_second_cents, now()
  );
  perform public.apply_shopping_settlement_amount(
    target_household_id, second_member_id, first_member_id,
    first_owes_second_cents, now()
  );
end;
$$;

revoke all on function public.settle_zero_shopping_balance_as_admin(uuid, uuid) from public;
grant execute on function public.settle_zero_shopping_balance_as_admin(uuid, uuid) to authenticated;
