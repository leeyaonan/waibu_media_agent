-- 阶段产物：大纲、草稿这类中间结果存在步骤上，供下一阶段读取与审计。
alter table waibu_steps add column if not exists payload jsonb
