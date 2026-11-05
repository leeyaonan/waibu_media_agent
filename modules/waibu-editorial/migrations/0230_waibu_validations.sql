-- 排版校验结果：每次检测留一条，导出只认最近一次 passed 的记录。
create table if not exists waibu_validations (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references waibu_revisions(id) on delete cascade,
  validator text not null,
  version text not null,
  status text not null check (status in ('passed', 'failed', 'validator_error')),
  report jsonb not null,
  screenshots text[] not null default '{}',
  created_at timestamptz not null default now()
)
