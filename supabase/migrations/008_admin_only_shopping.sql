-- Casa Cinco — administração das compras exclusiva para administradores.
-- Rode depois da 007_remove_item_from_purchase.sql.

-- Perfis antigos podem ter recebido esta permissão granular. Ela deixa de
-- existir para moradores, mas as demais permissões do perfil são preservadas.
update public.profiles
set permissions = permissions - 'manage_shopping'
where permissions ? 'manage_shopping';

-- Mantém compatibilidade com funções e políticas antigas que consultam
-- has_permission('manage_shopping'), tornando essa chave exclusiva do admin.
create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce(
    (
      select case
        when perm = 'manage_shopping'
          then p.role = 'admin'::public.user_role
        else p.role = 'admin'::public.user_role
          or coalesce((p.permissions ->> perm)::boolean, false)
        end
      from public.profiles p
      where p.id = auth.uid()
        and p.household_id = public.current_household_id()
    ),
    false
  )
$$;

-- Itens abertos: leitura continua liberada para a casa; escrita fica apenas
-- com a política shopping_admin_all criada nas migrações anteriores.
drop policy if exists shopping_permission_write on public.shopping_items;
drop policy if exists shopping_permission_update on public.shopping_items;
drop policy if exists shopping_permission_delete on public.shopping_items;

-- Compras consolidadas e seus rateios também só podem ser alterados pelo
-- administrador. As políticas de leitura permanecem inalteradas.
drop policy if exists shopping_purchases_manage on public.shopping_purchases;
create policy shopping_purchases_manage on public.shopping_purchases
for all to authenticated
using (public.is_house_admin(household_id))
with check (public.is_house_admin(household_id));

drop policy if exists shopping_purchase_shares_manage on public.shopping_purchase_shares;
create policy shopping_purchase_shares_manage on public.shopping_purchase_shares
for all to authenticated
using (exists (
  select 1
  from public.shopping_purchases p
  where p.id = purchase_id
    and public.is_house_admin(p.household_id)
))
with check (exists (
  select 1
  from public.shopping_purchases p
  where p.id = purchase_id
    and public.is_house_admin(p.household_id)
));

-- Protege também os rateios legados da migração 005.
drop policy if exists shopping_item_shares_manage on public.shopping_item_shares;
create policy shopping_item_shares_manage on public.shopping_item_shares
for all to authenticated
using (exists (
  select 1
  from public.shopping_items i
  where i.id = shopping_item_id
    and public.is_house_admin(i.household_id)
))
with check (exists (
  select 1
  from public.shopping_items i
  where i.id = shopping_item_id
    and public.is_house_admin(i.household_id)
));
