-- 由事实反查引用它的版本。
create index concurrently if not exists waibu_revision_claims_claim_idx on waibu_revision_claims (claim_id)
