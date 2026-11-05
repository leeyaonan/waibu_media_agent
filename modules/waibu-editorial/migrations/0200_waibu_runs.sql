-- 一次运行：定时与人工分开编号，业务日期用北京时间。
create table if not exists waibu_runs (
  id uuid primary key default gen_random_uuid(),
  business_date date not null,
  mode text not null check (mode in ('scheduled', 'manual')),
  pipeline_version text not null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','paused_budget','waiting_input','cancelled')),
  input_hash text not null,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
