-- Comprovante do pagamento total da despesa, separado dos comprovantes
-- individuais enviados por cada morador.
-- Rode depois da 018.

alter table public.expenses
  add column if not exists payment_receipt_path text,
  add column if not exists payment_receipt_name text,
  add column if not exists payment_receipt_uploaded_by uuid references auth.users(id) on delete set null,
  add column if not exists payment_receipt_uploaded_at timestamptz;

