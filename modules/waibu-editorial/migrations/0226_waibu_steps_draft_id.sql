-- 阶段记录关联稿件，用于统计单篇稿件的调用次数与 token 消耗。
alter table waibu_steps add column if not exists draft_id uuid
