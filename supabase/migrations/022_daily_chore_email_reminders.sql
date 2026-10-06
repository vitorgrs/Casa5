-- Lembrete diário por e-mail para o responsável pela rotina da casa.
-- Rode depois da 021_laundry_calendar.sql.

create table if not exists public.daily_chore_reminder_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  member_id uuid not null,
  reminder_date date not null,
  recipient_email text not null,
  message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (household_id, member_id, reminder_date),
  foreign key (household_id, member_id)
    references public.household_members(household_id, id) on delete cascade
);

create index if not exists daily_chore_reminder_log_period_idx
  on public.daily_chore_reminder_log(household_id, reminder_date desc);

alter table public.daily_chore_reminder_log enable row level security;

create policy daily_chore_reminder_log_admin_read
on public.daily_chore_reminder_log for select to authenticated
using (public.is_house_admin(household_id));

create policy daily_chore_reminder_log_service_all
on public.daily_chore_reminder_log for all to service_role
using (true) with check (true);

-- Ajusta a rotina padrão para refletir exatamente o conteúdo do lembrete.
insert into public.daily_standard_tasks (
  household_id,
  task_key,
  label,
  description,
  display_order,
  active
)
select
  household.id,
  defaults.task_key,
  defaults.label,
  defaults.description,
  defaults.display_order,
  true
from public.households household
cross join (values
  (
    'kitchen_trash',
    'Retirar o lixo da cozinha',
    'Retire o saco e coloque um saco novo na lixeira.',
    1
  ),
  (
    'bathroom_trash',
    'Verificar o lixo dos banheiros que utiliza',
    'Se alguma lixeira estiver cheia, retire o lixo e coloque um saco novo.',
    2
  ),
  (
    'dish_rack_evening',
    'Guardar as louças do seca-louças a partir das 19h',
    'Se ainda estiverem molhadas, seque todas as louças antes de guardar.',
    3
  )
) as defaults(task_key, label, description, display_order)
on conflict (household_id, task_key) do update
set label = excluded.label,
    description = excluded.description,
    display_order = excluded.display_order,
    active = true,
    updated_at = now();

update public.daily_standard_tasks
set active = false,
    updated_at = now()
where task_key in (
  'bathroom_1_trash',
  'bathroom_2_trash',
  'bathroom_3_trash',
  'water_bottles'
);
