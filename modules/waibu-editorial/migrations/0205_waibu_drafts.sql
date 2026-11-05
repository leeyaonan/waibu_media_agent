-- 稿件：current 与 approved 两个指针分开，lock_version 做乐观并发。
create table if not exists waibu_drafts (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null unique references waibu_topics (id) on delete cascade,
  state text not null default 'drafting' check (state in ('drafting', 'checking', 'in_review', 'revising', 'approved', 'exported', 'published', 'on_hold', 'rejected')),
  current_revision_id uuid,
  approved_revision_id uuid,
  lock_version integer not null default 1 check (lock_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
