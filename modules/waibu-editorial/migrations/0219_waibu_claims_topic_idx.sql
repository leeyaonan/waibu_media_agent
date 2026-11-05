-- 按选题列出事实。
create index concurrently if not exists waibu_claims_topic_idx on waibu_claims (topic_id, created_at)
