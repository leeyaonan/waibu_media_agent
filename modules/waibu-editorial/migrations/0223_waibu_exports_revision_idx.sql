-- 按版本查发布包。
create index concurrently if not exists waibu_exports_revision_idx on waibu_exports (revision_id, created_at desc)
