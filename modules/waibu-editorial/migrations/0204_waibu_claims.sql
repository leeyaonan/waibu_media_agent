-- 事实：正文里每一句要能追到证据；模型自述与评分不能单独证明事实。
create table if not exists waibu_claims (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references waibu_topics (id) on delete cascade,
  text text not null check (length(text) > 0),
  kind text not null check (kind in ('factual', 'inference', 'author_opinion')),
  evidence_ids uuid[] not null default '{}',
  status text not null default 'unchecked' check (status in ('unchecked', 'supported', 'disputed', 'unsupported')),
  checked_at timestamptz,
  created_at timestamptz not null default now()
)
