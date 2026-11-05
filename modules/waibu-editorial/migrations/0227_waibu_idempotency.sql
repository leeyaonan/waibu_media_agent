-- 写请求去重：同一个人带同一个 Idempotency-Key 重复提交，只执行一次并把结果原样返回。
create table if not exists waibu_idempotency (
  key text primary key,
  actor text not null,
  path text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now()
)
