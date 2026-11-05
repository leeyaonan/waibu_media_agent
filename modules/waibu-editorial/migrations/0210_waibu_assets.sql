-- 素材：文件在私有持久卷，按内容 hash 去重；未知授权的素材不进正式包。
create table if not exists waibu_assets (
  id uuid primary key default gen_random_uuid(),
  hash text not null unique check (hash ~ '^sha256:[0-9a-f]{64}$'),
  path text not null check (length(path) > 0),
  mime text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  origin text not null default 'unknown' check (origin in ('author_upload', 'source_capture', 'generated_cover', 'licensed', 'unknown')),
  rights text not null default 'unknown' check (rights in ('quotation', 'public', 'licensed', 'unknown')),
  created_at timestamptz not null default now()
)
