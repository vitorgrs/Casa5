-- Reclamações anônimas com acompanhamento privado pelo autor.
-- Rode depois da 019 (módulo financeiro).

create table if not exists public.complaints (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  protocol text not null unique default (
    'REC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  subject text not null check (char_length(trim(subject)) between 3 and 120),
  message text not null check (char_length(trim(message)) between 10 and 3000),
  status text not null default 'under_review'
    check (status = 'under_review'),
  created_at timestamptz not null default now()
);

create index if not exists complaints_household_created_idx
  on public.complaints(household_id, created_at desc);

-- O vínculo fica separado do conteúdo. A aplicação nunca o expõe ao
-- administrador, preservando o anonimato na interface e nas APIs normais.
create table if not exists public.complaint_reporters (
  complaint_id uuid primary key references public.complaints(id) on delete cascade,
  reporter_profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists complaint_reporters_profile_idx
  on public.complaint_reporters(reporter_profile_id, created_at desc);

alter table public.complaints enable row level security;
alter table public.complaint_reporters enable row level security;

-- Não há políticas diretas de leitura/escrita. O acesso acontece somente pelas
-- funções abaixo, que retornam o conteúdo necessário sem expor a identidade.
create or replace function public.submit_anonymous_complaint(
  complaint_subject text,
  complaint_message text
)
returns table (complaint_id uuid, complaint_protocol text)
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  clean_subject text := trim(complaint_subject);
  clean_message text := trim(complaint_message);
  new_complaint_id uuid;
  new_protocol text;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null then
    raise exception 'Usuário ativo não encontrado.';
  end if;
  if char_length(clean_subject) < 3 or char_length(clean_subject) > 120 then
    raise exception 'O assunto deve ter entre 3 e 120 caracteres.';
  end if;
  if char_length(clean_message) < 10 or char_length(clean_message) > 3000 then
    raise exception 'A reclamação deve ter entre 10 e 3000 caracteres.';
  end if;

  insert into public.complaints (household_id, subject, message)
  values (acting_profile.household_id, clean_subject, clean_message)
  returning id, protocol into new_complaint_id, new_protocol;

  insert into public.complaint_reporters (complaint_id, reporter_profile_id)
  values (new_complaint_id, acting_profile.id);

  return query select new_complaint_id, new_protocol;
end;
$$;

create or replace function public.list_my_anonymous_complaints()
returns table (
  id uuid,
  protocol text,
  subject text,
  message text,
  status text,
  created_at timestamptz
)
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
  where profiles.id = auth.uid()
    and profiles.status = 'active'
    and profiles.household_id is not null;

  if acting_profile.id is null then
    raise exception 'Usuário ativo não encontrado.';
  end if;

  return query
  select
    complaint.id,
    complaint.protocol,
    complaint.subject,
    complaint.message,
    complaint.status,
    complaint.created_at
  from public.complaint_reporters reporter
  join public.complaints complaint on complaint.id = reporter.complaint_id
  where reporter.reporter_profile_id = acting_profile.id
    and complaint.household_id = acting_profile.household_id
  order by complaint.created_at desc;
end;
$$;

revoke all on function public.submit_anonymous_complaint(text, text) from public;
revoke all on function public.list_my_anonymous_complaints() from public;
grant execute on function public.submit_anonymous_complaint(text, text) to authenticated;
grant execute on function public.list_my_anonymous_complaints() to authenticated;
