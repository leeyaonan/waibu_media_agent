-- 发布包：只对当前有效批准生成；导出不等于已发布。
create table if not exists waibu_exports (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references waibu_revisions (id) on delete cascade,
  approval_id uuid not null references waibu_approvals (id) on delete cascade,
  manifest_hash text not null check (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  path text not null,
  validator_version text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  created_at timestamptz not null default now()
)
