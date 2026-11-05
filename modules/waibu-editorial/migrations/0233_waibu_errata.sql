-- 勘误：已发布的文章不改写原文，只追加一条更正记录。
create table if not exists waibu_errata (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references waibu_publications(id) on delete cascade,
  note text not null check (length(note) between 1 and 2000),
  recorded_by text not null,
  created_at timestamptz not null default now()
)
