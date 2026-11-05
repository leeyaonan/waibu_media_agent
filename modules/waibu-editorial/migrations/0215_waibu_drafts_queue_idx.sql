-- 审核队列按状态与更新时间翻页。
create index concurrently if not exists waibu_drafts_queue_idx on waibu_drafts (state, updated_at desc)
