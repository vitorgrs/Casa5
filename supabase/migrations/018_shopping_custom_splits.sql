-- Casa Cinco — mutações atômicas da organização e rateio personalizado de compras.
-- Rode depois da 017_admin_payments_without_receipt.sql.

alter table public.shopping_purchases
  add column if not exists split_mode text not null default 'equal';

alter table public.shopping_purchases
  drop constraint if exists shopping_purchases_split_mode_check;
alter table public.shopping_purchases
  add constraint shopping_purchases_split_mode_check
  check (split_mode in ('equal', 'custom'));

-- Cria a tarefa e todos os responsáveis na mesma transação. Qualquer falha
-- desfaz o conjunto inteiro e evita tarefas parcialmente cadastradas.
create or replace function public.create_task_with_assignees(
  selected_scope text,
  task_title text,
  task_description text,
  task_due_date date,
  assignee_member_ids uuid[]
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_household_id uuid := public.current_household_id();
  normalized_assignees uuid[];
  assignee_count integer;
  valid_assignee_count integer;
  new_task_id uuid;
begin
  if not public.has_permission('manage_tasks') then
    raise exception 'Você não tem permissão para criar tarefas.';
  end if;
  if selected_scope not in ('casa', 'geral') then
    raise exception 'Tipo de tarefa inválido.';
  end if;
  task_title := btrim(coalesce(task_title, ''));
  if task_title = '' then
    raise exception 'Informe um título para a tarefa.';
  end if;

  select array_agg(distinct member_id order by member_id)
    into normalized_assignees
  from unnest(coalesce(assignee_member_ids, array[]::uuid[]))
    as assignees(member_id);

  assignee_count := coalesce(cardinality(normalized_assignees), 0);
  if assignee_count > 0 then
    select count(*) into valid_assignee_count
    from public.household_members
    where id = any(normalized_assignees)
      and household_id = target_household_id
      and active = true;
    if valid_assignee_count <> assignee_count then
      raise exception 'Há um responsável inválido na tarefa.';
    end if;
  end if;

  insert into public.tasks (
    household_id,
    scope,
    title,
    description,
    due_date,
    source,
    created_by
  ) values (
    target_household_id,
    selected_scope::public.task_scope,
    task_title,
    nullif(btrim(coalesce(task_description, '')), ''),
    task_due_date,
    'manual',
    auth.uid()
  )
  returning id into new_task_id;

  if assignee_count > 0 then
    insert into public.task_assignees (task_id, member_id, done, done_at)
    select
      new_task_id,
      member_id,
      selected_scope = 'casa',
      case when selected_scope = 'casa' then now() else null end
    from unnest(normalized_assignees) as assignees(member_id);
  end if;

  return new_task_id;
end;
$$;

revoke all on function public.create_task_with_assignees(text, text, text, date, uuid[]) from public;
grant execute on function public.create_task_with_assignees(text, text, text, date, uuid[]) to authenticated;

-- O nome v2 mantém o RPC anterior disponível durante deploys graduais. A
-- aplicação nova envia os valores personalizados em centavos, indexados pelo
-- UUID do participante, evitando depender da ordem dos arrays.
create or replace function public.record_multi_item_shopping_purchase_v2(
  target_item_ids uuid[],
  purchased_quantities numeric[],
  purchased_unit_prices numeric[],
  selected_scope text,
  payer_member_id uuid,
  participant_member_ids uuid[],
  selected_split_mode text,
  custom_share_cents jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_household_id uuid := public.current_household_id();
  normalized_participants uuid[];
  participant_count integer;
  valid_member_count integer;
  valid_item_count integer;
  total_cents bigint := 0;
  item_cents bigint;
  base_cents bigint := 0;
  remaining_cents bigint := 0;
  custom_total_cents bigint := 0;
  current_share_cents bigint;
  current_share_text text;
  current_member_id uuid;
  current_position integer := 0;
  current_quantity numeric;
  current_unit_price numeric;
  item_position integer;
  new_purchase_id uuid := gen_random_uuid();
begin
  if not public.has_permission('manage_shopping') then
    raise exception 'Você não tem permissão para registrar compras.';
  end if;
  if target_item_ids is null or cardinality(target_item_ids) = 0 then
    raise exception 'Selecione pelo menos um item.';
  end if;
  if cardinality(target_item_ids) <> cardinality(purchased_quantities)
    or cardinality(target_item_ids) <> cardinality(purchased_unit_prices) then
    raise exception 'Os dados dos itens estão incompletos.';
  end if;
  if (select count(distinct item_id) from unnest(target_item_ids) as ids(item_id))
    <> cardinality(target_item_ids) then
    raise exception 'Um item foi selecionado mais de uma vez.';
  end if;
  if selected_scope is null or selected_scope not in ('household', 'group', 'individual') then
    raise exception 'Tipo de compra inválido.';
  end if;
  if selected_split_mode is null or selected_split_mode not in ('equal', 'custom') then
    raise exception 'Tipo de divisão inválido.';
  end if;

  if not exists (
    select 1 from public.household_members
    where id = payer_member_id
      and household_id = target_household_id
      and active = true
  ) then
    raise exception 'O pagador não pertence a esta casa.';
  end if;

  if selected_scope = 'household' then
    select array_agg(id order by display_order, id)
      into normalized_participants
    from public.household_members
    where household_id = target_household_id and active = true;
  else
    select array_agg(distinct participant_id order by participant_id)
      into normalized_participants
    from unnest(coalesce(participant_member_ids, array[]::uuid[]))
      as participants(participant_id);
  end if;

  participant_count := coalesce(cardinality(normalized_participants), 0);
  if participant_count = 0 then
    raise exception 'Selecione quem participa da compra.';
  end if;
  if selected_scope = 'group' and participant_count < 2 then
    raise exception 'Uma compra de grupo precisa ter pelo menos duas pessoas.';
  end if;
  if selected_scope = 'individual' and participant_count <> 1 then
    raise exception 'Uma compra individual precisa ter exatamente uma pessoa.';
  end if;

  select count(*) into valid_member_count
  from public.household_members
  where id = any(normalized_participants)
    and household_id = target_household_id
    and active = true;
  if valid_member_count <> participant_count then
    raise exception 'Há um participante inválido no rateio.';
  end if;

  perform 1
  from public.shopping_items
  where id = any(target_item_ids)
    and household_id = target_household_id
  for update;

  select count(*) into valid_item_count
  from public.shopping_items
  where id = any(target_item_ids)
    and household_id = target_household_id
    and status in ('list'::public.shopping_status, 'checked'::public.shopping_status);
  if valid_item_count <> cardinality(target_item_ids) then
    raise exception 'Há um item inválido ou já comprado na seleção.';
  end if;

  for item_position in 1..cardinality(target_item_ids) loop
    current_quantity := round(purchased_quantities[item_position], 2);
    current_unit_price := round(purchased_unit_prices[item_position], 2);
    if current_quantity is null or current_unit_price is null
      or current_quantity <= 0 or current_unit_price < 0 then
      raise exception 'Quantidade ou valor inválido no item %.', item_position;
    end if;
    item_cents := round(current_quantity * current_unit_price * 100)::bigint;
    total_cents := total_cents + item_cents;
  end loop;

  if selected_split_mode = 'custom' then
    if custom_share_cents is null or jsonb_typeof(custom_share_cents) <> 'object' then
      raise exception 'Informe os valores personalizados da compra.';
    end if;
    if (select count(*) from jsonb_object_keys(custom_share_cents))
      <> participant_count then
      raise exception 'Informe exatamente um valor para cada participante.';
    end if;

    foreach current_member_id in array normalized_participants loop
      current_share_text := custom_share_cents ->> current_member_id::text;
      if current_share_text is null or current_share_text !~ '^[0-9]+$' then
        raise exception 'Há um valor personalizado inválido.';
      end if;
      current_share_cents := current_share_text::bigint;
      custom_total_cents := custom_total_cents + current_share_cents;
    end loop;

    if custom_total_cents <> total_cents then
      raise exception 'A divisão personalizada deve somar exatamente o total da compra.';
    end if;
  else
    base_cents := total_cents / participant_count;
    remaining_cents := total_cents - (base_cents * participant_count);
  end if;

  insert into public.shopping_purchases (
    id,
    household_id,
    paid_by_member_id,
    purchase_scope,
    split_mode,
    total_amount,
    bought_at,
    created_by
  ) values (
    new_purchase_id,
    target_household_id,
    payer_member_id,
    selected_scope,
    selected_split_mode,
    total_cents / 100.0,
    now(),
    auth.uid()
  );

  for item_position in 1..cardinality(target_item_ids) loop
    current_quantity := round(purchased_quantities[item_position], 2);
    current_unit_price := round(purchased_unit_prices[item_position], 2);
    update public.shopping_items
    set status = 'bought',
        quantity_bought = current_quantity,
        unit_price = current_unit_price,
        purchase_scope = selected_scope,
        paid_by_member_id = payer_member_id,
        purchase_id = new_purchase_id,
        bought_at = now()
    where id = target_item_ids[item_position];
  end loop;

  foreach current_member_id in array normalized_participants loop
    current_position := current_position + 1;
    current_share_cents := case
      when selected_split_mode = 'custom'
        then (custom_share_cents ->> current_member_id::text)::bigint
      else base_cents + case when current_position <= remaining_cents then 1 else 0 end
    end;

    insert into public.shopping_purchase_shares (
      purchase_id,
      member_id,
      amount,
      payment_status,
      paid_at
    ) values (
      new_purchase_id,
      current_member_id,
      current_share_cents / 100.0,
      case when current_share_cents = 0 or current_member_id = payer_member_id
        then 'paid'::public.share_status else 'pending'::public.share_status end,
      case when current_share_cents = 0 or current_member_id = payer_member_id
        then now() else null end
    );
  end loop;

  return new_purchase_id;
end;
$$;

revoke all on function public.record_multi_item_shopping_purchase_v2(
  uuid[], numeric[], numeric[], text, uuid, uuid[], text, jsonb
) from public;
grant execute on function public.record_multi_item_shopping_purchase_v2(
  uuid[], numeric[], numeric[], text, uuid, uuid[], text, jsonb
) to authenticated;

-- Não existe uma regra universal para redistribuir automaticamente o valor de
-- um item removido de um rateio personalizado. Nesse caso exigimos desfazer a
-- compra inteira e registrá-la novamente, preservando o histórico financeiro.
create or replace function public.remove_item_from_shopping_purchase(
  target_purchase_id uuid,
  target_item_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_household_id uuid;
  payer_member_id uuid;
  target_split_mode text;
  purchase_item_count integer;
  participant_member_ids uuid[];
  participant_count integer;
  total_cents bigint;
  base_cents bigint;
  remaining_cents bigint;
  current_member_id uuid;
  current_position integer := 0;
begin
  if not public.has_permission('manage_shopping') then
    raise exception 'Você não tem permissão para alterar compras.';
  end if;

  select household_id, paid_by_member_id, split_mode
    into target_household_id, payer_member_id, target_split_mode
  from public.shopping_purchases
  where id = target_purchase_id
    and household_id = public.current_household_id()
  for update;

  if target_household_id is null then
    raise exception 'Compra não encontrada.';
  end if;

  perform 1
  from public.shopping_items
  where id = target_item_id
    and purchase_id = target_purchase_id
    and household_id = target_household_id
  for update;
  if not found then
    raise exception 'Este item não pertence à compra informada.';
  end if;

  if exists (
    select 1
    from public.shopping_purchase_shares
    where purchase_id = target_purchase_id
      and (
        receipt_path is not null
        or (
          member_id <> payer_member_id
          and payment_status <> 'pending'::public.share_status
          and amount > 0
        )
      )
  ) then
    raise exception 'Não é possível retirar itens depois que existe comprovante ou pagamento confirmado.';
  end if;

  select count(*) into purchase_item_count
  from public.shopping_items
  where purchase_id = target_purchase_id;

  if target_split_mode = 'custom' and purchase_item_count > 1 then
    raise exception 'Para alterar uma compra com valores personalizados, devolva todos os itens à lista e registre a compra novamente.';
  end if;

  update public.shopping_items
  set status = 'list',
      checked_at = null,
      bought_at = null,
      quantity_bought = null,
      unit_price = null,
      purchase_scope = null,
      paid_by_member_id = null,
      purchase_id = null
  where id = target_item_id;

  if purchase_item_count = 1 then
    delete from public.shopping_purchases where id = target_purchase_id;
    return;
  end if;

  select coalesce(sum(round(quantity_bought * unit_price * 100)), 0)::bigint
    into total_cents
  from public.shopping_items
  where purchase_id = target_purchase_id;

  update public.shopping_purchases
  set total_amount = total_cents / 100.0
  where id = target_purchase_id;

  select array_agg(member_id order by created_at, id)
    into participant_member_ids
  from public.shopping_purchase_shares
  where purchase_id = target_purchase_id;

  participant_count := coalesce(cardinality(participant_member_ids), 0);
  if participant_count = 0 then
    raise exception 'A compra não possui participantes para recalcular o rateio.';
  end if;

  base_cents := total_cents / participant_count;
  remaining_cents := total_cents - (base_cents * participant_count);

  foreach current_member_id in array participant_member_ids loop
    current_position := current_position + 1;
    update public.shopping_purchase_shares
    set amount = (base_cents + case when current_position <= remaining_cents then 1 else 0 end) / 100.0,
        payment_status = case
          when total_cents = 0 or current_member_id = payer_member_id
            then 'paid'::public.share_status
          else 'pending'::public.share_status
        end,
        paid_at = case
          when total_cents = 0 or current_member_id = payer_member_id then now()
          else null
        end
    where purchase_id = target_purchase_id
      and member_id = current_member_id;
  end loop;
end;
$$;

revoke all on function public.remove_item_from_shopping_purchase(uuid, uuid) from public;
grant execute on function public.remove_item_from_shopping_purchase(uuid, uuid) to authenticated;
