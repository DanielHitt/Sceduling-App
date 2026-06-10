-- Office scheduler — full schema. Run this on a fresh Supabase project
-- (SQL Editor → paste → run) to set it up from scratch.
create extension if not exists moddatetime with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table public.providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#2563eb',
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  series_id uuid,
  patient_name text not null,
  patient_phone text,
  patient_email text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  notes text,
  status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled','no_show')),
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index appointments_starts_at_idx on public.appointments (starts_at);
create index appointments_series_id_idx on public.appointments (series_id) where series_id is not null;
create trigger appointments_updated_at before update on public.appointments
  for each row execute procedure extensions.moddatetime(updated_at);

create table public.message_log (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid references public.appointments(id) on delete set null,
  recipient text not null,
  kind text not null,
  subject text,
  body text,
  status text not null default 'sent',
  error text,
  sent_at timestamptz not null default now()
);
create index message_log_appointment_idx on public.message_log (appointment_id);

create table public.clinic_settings (
  id int primary key default 1 check (id = 1),
  clinic_name text not null default 'Our Office',
  reminder_hours int not null default 24,
  timezone text not null default 'America/New_York',
  updated_at timestamptz not null default now()
);
insert into public.clinic_settings (id) values (1);
create trigger clinic_settings_updated_at before update on public.clinic_settings
  for each row execute procedure extensions.moddatetime(updated_at);

-- RLS: any signed-in staff member has full access; anonymous users have none.
alter table public.providers enable row level security;
alter table public.appointments enable row level security;
alter table public.message_log enable row level security;
alter table public.clinic_settings enable row level security;

create policy "staff full access" on public.providers
  for all to authenticated using (true) with check (true);
create policy "staff full access" on public.appointments
  for all to authenticated using (true) with check (true);
create policy "staff full access" on public.message_log
  for all to authenticated using (true) with check (true);
create policy "staff full access" on public.clinic_settings
  for all to authenticated using (true) with check (true);

-- Live updates so multiple front-desk screens stay in sync.
alter publication supabase_realtime add table public.appointments;
alter publication supabase_realtime add table public.providers;

-- Automatic reminders: every 15 minutes, ping the send-reminders edge function.
-- IMPORTANT: replace <PROJECT-REF> and <ANON-KEY> with your project's values
-- (Dashboard → Settings → API). The anon key is public, so this is safe.
-- select cron.schedule(
--   'scheduler-send-reminders',
--   '*/15 * * * *',
--   $$
--   select net.http_post(
--     url := 'https://<PROJECT-REF>.supabase.co/functions/v1/send-reminders',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <ANON-KEY>'
--     ),
--     body := '{}'::jsonb
--   );
--   $$
-- );
