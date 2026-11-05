-- 发布登记：只由作者明确操作产生，不从导出动作推断。
create table if not exists waibu_publications (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references waibu_revisions (id) on delete cascade,
  channel text not null default 'wechat_mp' check (channel in ('wechat_mp')),
  published_at timestamptz not null,
  url text,
  recorded_by text not null check (length(recorded_by) > 0),
  created_at timestamptz not null default now(),
  unique (revision_id, channel)
)
