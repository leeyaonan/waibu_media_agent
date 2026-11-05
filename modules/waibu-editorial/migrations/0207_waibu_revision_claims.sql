-- 正文段落与事实的映射；复制正文时不显示内部 ID。
create table if not exists waibu_revision_claims (
  revision_id uuid not null references waibu_revisions (id) on delete cascade,
  block_id text not null check (length(block_id) > 0),
  claim_id uuid not null references waibu_claims (id) on delete cascade,
  primary key (revision_id, block_id)
)
