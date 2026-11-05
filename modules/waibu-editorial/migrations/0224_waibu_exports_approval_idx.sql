-- 撤销批准时失效对应发布包。
create index concurrently if not exists waibu_exports_approval_idx on waibu_exports (approval_id)
