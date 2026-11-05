-- 作者驳回时要保留原因，用于复盘选题和写作问题。
alter table waibu_drafts add column if not exists reject_reason text
