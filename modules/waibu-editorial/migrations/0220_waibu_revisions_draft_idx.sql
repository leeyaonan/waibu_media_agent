-- 版本历史按稿件倒序。
create index concurrently if not exists waibu_revisions_draft_idx on waibu_revisions (draft_id, created_at desc)
