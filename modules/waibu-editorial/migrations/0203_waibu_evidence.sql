-- 证据快照：只存支持结论的摘录，来源变化不改写旧快照，另记 validity。
create table if not exists waibu_evidence (
  id uuid primary key default gen_random_uuid(),
  source_id text not null,
  article_id text not null,
  url text not null check (url ~ '^https?://'),
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  excerpt text not null check (length(excerpt) > 0),
  hash text not null,
  rights text not null default 'unknown' check (rights in ('quotation', 'public', 'licensed', 'unknown')),
  validity text not null default 'valid' check (validity in ('valid', 'changed', 'withdrawn')),
  created_at timestamptz not null default now()
)
