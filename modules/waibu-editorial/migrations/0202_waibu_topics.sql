-- 候选选题：一个事件可以有多个角度，同事件同角度用 dedupe_key 去重。
create table if not exists waibu_topics (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references waibu_runs (id) on delete cascade,
  story_ids bigint[] not null check (cardinality(story_ids) > 0),
  angle text not null check (length(angle) > 0),
  reason text not null default '',
  evidence_status text not null default 'insufficient' check (evidence_status in ('sufficient', 'insufficient', 'disputed')),
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
)
