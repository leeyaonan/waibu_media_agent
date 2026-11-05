-- 运行使用的配置版本：配置改了之后，旧运行仍然指向它当时那一版。
alter table waibu_runs add column if not exists config_version integer
