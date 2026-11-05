-- 人工批准：绑定 revision 与内容 hash；撤销后不能再用它导出。
create table if not exists waibu_approvals (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references waibu_drafts (id) on delete cascade,
  revision_id uuid not null references waibu_revisions (id) on delete cascade,
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  actor text not null check (length(actor) > 0),
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  reason text
)
