-- 阶段执行记录；同一 run 的同一阶段、同一输入、同一尝试只能有一条。
create table if not exists waibu_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references waibu_runs (id) on delete cascade,
  stage text not null check (stage in ('evidence', 'outline', 'draft', 'check', 'revise')),
  input_hash text not null,
  attempt integer not null default 1 check (attempt >= 1),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','paused_budget','waiting_input','cancelled')),
  receipt_id bigint,
  output_ref text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, stage, input_hash, attempt)
)
