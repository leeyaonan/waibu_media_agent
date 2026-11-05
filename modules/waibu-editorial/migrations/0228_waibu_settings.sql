-- 编辑策略配置：单行保存当前生效值，每次修改升版本，运行记录自己用了哪一版。
create table if not exists waibu_settings (
  id smallint primary key default 1 check (id = 1),
  config jsonb not null,
  version integer not null default 1 check (version >= 1),
  updated_by text,
  updated_at timestamptz not null default now()
)
