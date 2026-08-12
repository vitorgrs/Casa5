-- Casa Cinco — painel administrativo de todos os acertos de compras.
-- Rode depois da 010_expense_receipt_before_paid.sql.

-- O devedor continua podendo enviar o próprio comprovante. O administrador
-- também pode anexá-lo em nome do devedor pelo painel de todos os acertos.
create or replace function public.submit_shopping_net_receipt(
  target_share_id uuid,
  uploaded_path text,
  uploaded_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  debtor_member_id uuid;
  creditor_member_id uuid;
  target_household_id uuid;
  gross_outgoing numeric(12,2);
  gross_incoming numeric(12,2);
begin
  select s.member_id, p.paid_by_member_id, p.household_id
    into debtor_member_id, creditor_member_id, target_household_id
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  join public.profiles profile on profile.id = auth.uid()
  where s.id = target_share_id
    and s.payment_status = 'pending'
    and profile.status = 'active'
    and profile.household_id = p.household_id
    and (
      profile.member_id = s.member_id
      or profile.role = 'admin'::public.user_role
    )
    and s.member_id <> p.paid_by_member_id;

  if debtor_member_id is null then
    raise exception 'Dívida não encontrada ou sem permissão para enviar o comprovante.';
  end if;
  if uploaded_path not like target_household_id::text || '/shopping-net/' || target_share_id::text || '/%' then
    raise exception 'Caminho do comprovante inválido.';
  end if;

  select coalesce(sum(s.amount), 0) into gross_outgoing
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = debtor_member_id
    and p.paid_by_member_id = creditor_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending';

  select coalesce(sum(s.amount), 0) into gross_incoming
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = creditor_member_id
    and p.paid_by_member_id = debtor_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending';

  if gross_outgoing <= gross_incoming then
    raise exception 'Após a compensação, esta pessoa não possui saldo a pagar.';
  end if;
  if exists (
    select 1
    from public.shopping_purchase_shares s
    join public.shopping_purchases p on p.id = s.purchase_id
    where s.member_id = debtor_member_id
      and p.paid_by_member_id = creditor_member_id
      and p.household_id = target_household_id
      and s.payment_status = 'pending'
      and s.receipt_path is not null
  ) then
    raise exception 'Já existe um comprovante aguardando confirmação para este acerto.';
  end if;

  update public.shopping_purchase_shares s
  set receipt_path = uploaded_path,
      receipt_name = uploaded_name,
      receipt_uploaded_by = auth.uid(),
      receipt_uploaded_at = now()
  from public.shopping_purchases p
  where p.id = s.purchase_id
    and p.household_id = target_household_id
    and s.member_id = debtor_member_id
    and p.paid_by_member_id = creditor_member_id
    and s.payment_status = 'pending';
end;
$$;

revoke all on function public.submit_shopping_net_receipt(uuid, text, text) from public;
grant execute on function public.submit_shopping_net_receipt(uuid, text, text) to authenticated;

-- Depois do comprovante, o recebedor ou o administrador pode confirmar o
-- pagamento. Sem arquivo anexado a função não encontra a parcela e recusa.
create or replace function public.confirm_shopping_net_payment(target_share_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  debtor_member_id uuid;
  creditor_member_id uuid;
  target_household_id uuid;
  receipt_cutoff timestamptz;
begin
  select s.member_id, p.paid_by_member_id, p.household_id, s.receipt_uploaded_at
    into debtor_member_id, creditor_member_id, target_household_id, receipt_cutoff
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  join public.profiles profile on profile.id = auth.uid()
  where s.id = target_share_id
    and s.payment_status = 'pending'
    and s.receipt_path is not null
    and s.receipt_uploaded_at is not null
    and profile.status = 'active'
    and profile.household_id = p.household_id
    and (
      profile.member_id = p.paid_by_member_id
      or profile.role = 'admin'::public.user_role
    );

  if debtor_member_id is null then
    raise exception 'O pagamento exige comprovante e só pode ser confirmado pelo recebedor ou administrador.';
  end if;

  update public.shopping_purchase_shares s
  set payment_status = 'paid', paid_at = now()
  from public.shopping_purchases p
  where p.id = s.purchase_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'
    and s.created_at <= receipt_cutoff
    and (
      (s.member_id = debtor_member_id and p.paid_by_member_id = creditor_member_id)
      or (s.member_id = creditor_member_id and p.paid_by_member_id = debtor_member_id)
    );
end;
$$;

revoke all on function public.confirm_shopping_net_payment(uuid) from public;
grant execute on function public.confirm_shopping_net_payment(uuid) to authenticated;

-- Quando os dois lados possuem exatamente o mesmo total, não há PIX nem
-- comprovante. O administrador pode encerrar as parcelas por compensação.
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
  first_owes_second numeric(12,2);
  second_owes_first numeric(12,2);
begin
  if first_member_id = second_member_id then
    raise exception 'Informe dois moradores diferentes.';
  end if;

  select household_id into target_household_id
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and role = 'admin'::public.user_role;

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

  select coalesce(sum(s.amount), 0) into first_owes_second
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = first_member_id
    and p.paid_by_member_id = second_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending';

  select coalesce(sum(s.amount), 0) into second_owes_first
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = second_member_id
    and p.paid_by_member_id = first_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending';

  if first_owes_second = 0 or first_owes_second <> second_owes_first then
    raise exception 'As dívidas não possuem o mesmo valor para quitação por compensação.';
  end if;

  update public.shopping_purchase_shares s
  set payment_status = 'paid', paid_at = now()
  from public.shopping_purchases p
  where p.id = s.purchase_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'
    and (
      (s.member_id = first_member_id and p.paid_by_member_id = second_member_id)
      or (s.member_id = second_member_id and p.paid_by_member_id = first_member_id)
    );
end;
$$;

revoke all on function public.settle_zero_shopping_balance_as_admin(uuid, uuid) from public;
grant execute on function public.settle_zero_shopping_balance_as_admin(uuid, uuid) to authenticated;
