-- Endurece o bucket privado de comprovantes. Upload e download passam por
-- autorização da aplicação e URLs assinadas criadas exclusivamente no servidor.
-- Rode depois da 023_atomic_expense_mutations.sql.

update storage.buckets
set file_size_limit = 8388608,
    allowed_mime_types = array[
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic'
    ]::text[]
where id = 'comprovantes';

drop policy if exists comprovantes_read on storage.objects;
drop policy if exists comprovantes_insert on storage.objects;
drop policy if exists comprovantes_delete on storage.objects;

-- Não são criadas policies substitutas para `authenticated`: as Server
-- Actions validam casa/alvo/permissão, o service role emite a URL curta e o
-- Storage aplica limite e MIME sobre o objeto real.
