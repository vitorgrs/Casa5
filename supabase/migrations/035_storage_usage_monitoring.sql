-- Monitoramento do uso do Supabase pelo administrador: tamanho do banco,
-- espaco usado no bucket de comprovantes e arquivos orfaos (enviados, mas
-- que nenhum registro referencia, por exemplo um upload interrompido).
-- O plano gratuito tem 500 MB de banco e 1 GB de Storage por projeto.
-- Rode depois da 034_dish_rack_cleaning_rotation.sql.

-- Todas as colunas text do schema public terminadas em "_path" guardam
-- caminhos do bucket (boleto_path, receipt_path, payment_receipt_path...).
-- A lista e lida do catalogo para que uma coluna nova seja considerada
-- automaticamente, sem risco de um anexo valido ser tratado como orfao.
create or replace function public.referenced_receipt_paths()
returns table (path text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  path_column record;
begin
  for path_column in
    select columns.table_name, columns.column_name
    from information_schema.columns columns
    join information_schema.tables tables
      on tables.table_schema = columns.table_schema
     and tables.table_name = columns.table_name
     and tables.table_type = 'BASE TABLE'
    where columns.table_schema = 'public'
      and columns.column_name like '%\_path' escape '\'
      and columns.data_type = 'text'
  loop
    return query execute format(
      'select %1$I::text from public.%2$I where %1$I is not null',
      path_column.column_name,
      path_column.table_name
    );
  end loop;
end;
$$;

revoke all on function public.referenced_receipt_paths() from public;

create or replace function public.storage_usage_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  household_prefix text;
  result jsonb;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode consultar o uso do armazenamento.';
  end if;

  household_prefix := acting_profile.household_id::text || '/';

  with household_objects as (
    select
      objects.name,
      objects.created_at,
      coalesce((objects.metadata ->> 'size')::bigint, 0) as size_bytes
    from storage.objects objects
    where objects.bucket_id = 'comprovantes'
      and objects.name like household_prefix || '%'
  ),
  referenced as (
    select distinct referenced_receipt_paths.path
    from public.referenced_receipt_paths()
  ),
  orphans as (
    select household_objects.*
    from household_objects
    where household_objects.created_at < now() - interval '24 hours'
      and not exists (
        select 1 from referenced where referenced.path = household_objects.name
      )
  )
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'bucket_bytes', (select coalesce(sum(size_bytes), 0) from household_objects),
    'bucket_objects', (select count(*) from household_objects),
    'orphan_bytes', (select coalesce(sum(size_bytes), 0) from orphans),
    'orphan_objects', (select count(*) from orphans)
  )
  into result;

  return result;
end;
$$;

revoke all on function public.storage_usage_summary() from public;
grant execute on function public.storage_usage_summary() to authenticated;

-- Lista os orfaos com mais de 24 horas para a Server Action remover pela API
-- do Storage (o Supabase nao permite apagar storage.objects via SQL). A
-- margem de 24 horas protege uploads em andamento.
create or replace function public.list_orphan_receipt_objects(max_items integer default 200)
returns table (path text, size_bytes bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode limpar o armazenamento.';
  end if;

  return query
  with referenced as (
    select distinct referenced_receipt_paths.path
    from public.referenced_receipt_paths()
  )
  select
    objects.name::text,
    coalesce((objects.metadata ->> 'size')::bigint, 0)
  from storage.objects objects
  where objects.bucket_id = 'comprovantes'
    and objects.name like acting_profile.household_id::text || '/%'
    and objects.created_at < now() - interval '24 hours'
    and not exists (
      select 1 from referenced where referenced.path = objects.name
    )
  order by objects.created_at
  limit least(greatest(coalesce(max_items, 200), 1), 500);
end;
$$;

revoke all on function public.list_orphan_receipt_objects(integer) from public;
grant execute on function public.list_orphan_receipt_objects(integer) to authenticated;
