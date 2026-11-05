-- 稿件版本：内容不可变，改动产生新行；content_hash 与内容必须一致，批准绑定它。
create table if not exists waibu_revisions (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references waibu_drafts (id) on delete cascade,
  parent_id uuid references waibu_revisions (id),
  title text not null,
  summary text not null default '',
  body text not null,
  cover_asset_hash text,
  captions jsonb not null default '{}',
  asset_hashes text[] not null default '{}',
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_hash_version integer not null default 1,
  policy_version text not null,
  created_by text not null check (created_by in ('model', 'author', 'model_after_feedback')),
  created_at timestamptz not null default now()
)
