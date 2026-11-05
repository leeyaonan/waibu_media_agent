-- 定时 run 按业务日期与管线版本唯一；人工重跑不受限。
create unique index concurrently if not exists waibu_runs_scheduled_unique on waibu_runs (business_date, pipeline_version) where mode = 'scheduled'
