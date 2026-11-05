-- 作者意见：必须绑定它针对的版本，落实后记录产生的版本。
create table if not exists waibu_feedback (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references waibu_drafts (id) on delete cascade,
  revision_id uuid not null references waibu_revisions (id) on delete cascade,
  block_id text,
  text text not null check (length(text) > 0),
  resolution_revision_id uuid references waibu_revisions (id),
  created_at timestamptz not null default now()
)
