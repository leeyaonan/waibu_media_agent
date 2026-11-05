# 部署、备份与回退

面向自托管场景（家里的 MacBook Air 24 小时运行）。全部命令都在仓库根目录执行。

## 1. 前置

- Docker Desktop（或 Docker Engine + compose 插件）
- 至少 4GB 空闲内存：镜像里带 Chromium，微信排版校验需要真实浏览器
- 首次构建需要能访问 npm 源与 Docker Hub；受限网络可用 `NPM_REGISTRY` 构建参数

## 2. 配置

复制 `.env.example` 为 `.env`，**必须显式确认这几项**：

| 变量 | 说明 |
| --- | --- |
| `COLLECT_ENABLED` | 默认 `false`；打开会真的去采集 |
| `MODEL_CALLS_ENABLED` | 默认 `false`；没有真实 key 时保持关闭，付费调用不会发生 |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 真实模型凭据；不配则所有模型阶段以 `model_off` 停下 |
| `PUPPETEER_EXECUTABLE_PATH` | 镜像内固定 `/usr/bin/chromium`，不要覆盖 |
| `SESSION_SECRET` / `IMG_PROXY_SIGN_SECRET` / `ADMIN_PASSWORD` | 生产必须换成强随机值，否则启动会被拒绝 |
| `WAIBU_STORY_FIXTURE` | 仅联调用；生产留空，由采集结果提供候选故事 |
| `AIHOT_DATA_DIR` | 素材与发布包的持久卷位置 |

密钥只放 `.env`（已被 `.gitignore` 忽略），不进镜像、不进 Git、不写日志。

## 3. 起服务

```bash
docker compose up -d db
docker compose run --rm setup        # 迁移 + 种子
docker compose up -d api worker web
```

健康检查：

```bash
curl -fsS http://127.0.0.1:3000/api/health
docker compose ps                    # api/worker/web 都应是 running
```

私有工作台在 `/editorial`，未登录会跳登录页；公开站点与后台都在同一个 web 进程。

## 4. 备份

自托管没有对象存储，备份落在本地磁盘（脚本默认 `~/waibu-backups`）：

```bash
DATABASE_URL=postgres://... AIHOT_DATA_DIR=/data ./tools/backup.sh
```

产出：

```
<时间戳>/db.dump        pg_dump 自定义格式
<时间戳>/data.tar.gz    素材、发布包与草稿附件
<时间戳>/SHA256SUMS     两个文件的 sha256
```

建议每天定时执行，并把 `~/waibu-backups` 同步到另一块磁盘或云盘——**只留一份等于没有备份**。

## 5. 恢复演练

```bash
./tools/restore-drill.sh ~/waibu-backups/<时间戳>
```

它会在**隔离环境**里做完整恢复，不碰正在用的数据：

1. 校验备份清单（sha256）
2. 恢复到独立数据库 `waibu_restore`
3. 解包素材到临时目录
4. 核对：草稿数量、每个附件字节 hash、发布包 manifest hash 重算后与库中记录一致

最后打印 `RESTORE_OK` 才算恢复成功。

真出事时的恢复步骤：

```bash
docker compose stop api worker web
psql "$ADMIN_URL" -c 'drop database if exists waibu with (force)'
psql "$ADMIN_URL" -c 'create database waibu'
pg_restore --no-owner --dbname "$DATABASE_URL" ~/waibu-backups/<时间戳>/db.dump
tar -xzf ~/waibu-backups/<时间戳>/data.tar.gz -C /data-parent
docker compose up -d api worker web
```

## 6. 回退

代码回退不影响数据：数据库只做追加迁移，旧版本能读新库的既有行。

```bash
git fetch origin && git checkout <上一个发布 tag 或 commit>
docker compose build && docker compose up -d
```

注意：
- **不要**回退到删除过列或表更早的版本；本仓库从 0200 起只新增
- 回退后用 `./tools/restore-drill.sh` 验证当前备份仍可恢复
- 发布包与其 manifest hash 由数据库记录约束，回退代码不会改变已导出的包

## 7. 付费开关

没有配置真实凭据时：

- `MODEL_CALLS_ENABLED=false`（默认）→ 所有模型阶段以 `model_off` 停下，阶段标失败而不是暂停
- 模型阶段失败会阻止稿件进入待审，不会静默产出空稿

上线前确认一遍：

```bash
docker compose exec api printenv MODEL_CALLS_ENABLED COLLECT_ENABLED
```

## 8. 已知边界

- 公众号后台的最终渲染效果无法自动验证，只能作者粘贴后目视确认
- 镜像构建需要外网；受限网络用 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com`
- 微信结构校验的规则版本锁定在 `verify-article-structure@0.2.28`，升级需重跑校验用例
