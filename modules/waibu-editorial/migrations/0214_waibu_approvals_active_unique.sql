-- 一份稿件同一时刻只能有一个有效批准。
create unique index concurrently if not exists waibu_approvals_active_unique on waibu_approvals (draft_id) where revoked_at is null
