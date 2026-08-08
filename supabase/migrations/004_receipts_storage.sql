-- Casa Cinco — comprovantes de pagamento (por morador) e boleto (por
-- despesa), guardados no Supabase Storage.
-- Rode depois da 003 (ou da 002, se você não tinha tabelas manuais extras).

-- ============================================================
-- 1) Colunas novas
-- ============================================================
alter table public.expenses
  add column if not exists boleto_path text,
  add column if not exists boleto_name text,
  add column if not exists boleto_uploaded_at timestamptz;

alter table public.expense_shares
  add column if not exists receipt_path text,
  add column if not exists receipt_name text,
  add column if not exists receipt_uploaded_by uuid references auth.users(id) on delete set null,
  add column if not exists receipt_uploaded_at timestamptz;

-- ============================================================
-- 2) Bucket privado no Storage
-- ============================================================
insert into storage.buckets (id, name, public)
values ('comprovantes', 'comprovantes', false)
on conflict (id) do nothing;

-- Convenção de caminho dos arquivos:
--   {household_id}/expenses/{expense_id}/boleto-{timestamp}-{nome}
--   {household_id}/shares/{share_id}/comprovante-{timestamp}-{nome}
-- Isso permite checar a permissão só olhando o primeiro segmento do path.

drop policy if exists comprovantes_read on storage.objects;
create policy comprovantes_read on storage.objects for select to authenticated
using (
  bucket_id = 'comprovantes'
  and (storage.foldername(name))[1] = (
    select household_id::text from public.profiles where id = auth.uid()
  )
);

drop policy if exists comprovantes_insert on storage.objects;
create policy comprovantes_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'comprovantes'
  and (storage.foldername(name))[1] = (
    select household_id::text from public.profiles where id = auth.uid()
  )
);

drop policy if exists comprovantes_delete on storage.objects;
create policy comprovantes_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'comprovantes'
  and (storage.foldername(name))[1] = (
    select household_id::text from public.profiles where id = auth.uid()
  )
  and (
    public.is_house_admin((select household_id from public.profiles where id = auth.uid()))
    or public.has_permission('manage_expenses')
  )
);
