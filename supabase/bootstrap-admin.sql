-- 1) Troque o e-mail abaixo pelo e-mail real do Vitor.
-- 2) Execute no SQL Editor antes OU depois de criar a conta no site.

update public.household_members
set email = 'vitor.grs2004@gmail.com'
where id = '11111111-1111-1111-1111-111111111101';

-- Se a conta já tiver sido criada, este trecho ativa o perfil imediatamente.
update public.profiles p
set member_id = m.id,
    household_id = m.household_id,
    role = 'admin',
    status = 'active',
    full_name = m.name
from public.household_members m
where m.id = '11111111-1111-1111-1111-111111111101'
  and lower(p.email) = lower(m.email);
