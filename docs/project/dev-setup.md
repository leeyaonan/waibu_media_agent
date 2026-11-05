# 本机开发与自测（F03 基线）

目标：干净机器照这份文档能跑起本仓库，且**默认不采集、不调用付费模型、不向外发送任何东西**。

## 1. 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | 24.22.2（见 `.nvmrc`） | 引擎要求 `>=24.22.1`；低版本 `npm ci` 会警告且部分语法跑不了 |
| npm | 随 Node 自带 | 仓库用 npm workspaces，不使用 pnpm |
| PostgreSQL | 17（`postgres:17-alpine`） | 测试库名必须以 `_test` 或 `_ci` 结尾 |

```bash
# 用 nvm 的机器
nvm install && nvm use          # 读 .nvmrc
node -v                          # 应为 v24.22.2

# 没有 nvm 的机器：直接用官方或镜像的 24.22.2 包
```

## 2. 数据库

```bash
docker run -d --name waibu-pg \
  -e POSTGRES_USER=waibu -e POSTGRES_PASSWORD=waibu_local_dev -e POSTGRES_DB=waibu_ci \
  -p 5432:5432 postgres:17-alpine

export DATABASE_URL=postgres://waibu:waibu_local_dev@127.0.0.1:5432/waibu_ci
```

`npm test` 会自己建库、跑迁移，并给每个测试文件一份独立副本（`tests/databases.ts`）；
库名不是 `_test`/`_ci` 结尾时直接拒绝运行，避免对着真实内容库做破坏性测试。

## 3. 安装与检查

```bash
npm ci --no-audit --no-fund
npm run typecheck                                   # 引擎 + 本模块契约
npm run build -w @aihot/web                         # Web 构建
npm test                                            # 后端测试（需要 DATABASE_URL）
npm run test:standalone                             # 不依赖数据库的测试
npm run test:web                                    # 需要先跑一次 npx playwright install chromium webkit
```

## 4. 起本地站点

```bash
node scripts/init-env.ts            # 生成 .env（含随机密钥与管理员密码；不会覆盖已有 .env）
```

生成的 `.env` 里 `COLLECT_ENABLED` 与 `MODEL_CALLS_ENABLED` 都是 `false`。手动确认一次：

```bash
grep -E '^(COLLECT_ENABLED|MODEL_CALLS_ENABLED)=' .env    # 两行都应为 false
```

然后：

```bash
node scripts/migrate.ts && node scripts/seed.ts     # 建表 + 示范信源
node apps/api/src/main.ts &                          # API :3001
node apps/worker/src/main.ts &                       # worker（开关都关时不会采集/调模型）
(cd apps/web && node server.ts) &                    # Web :3000
node scripts/smoke.ts --base http://127.0.0.1:3000
```

管理员入口 `/admin`，密码在 `.env` 的 `ADMIN_PASSWORD`。

## 5. 假模型

测试不访问任何外部模型：`tests/setup.ts` 把付费供应商指向本地 HTTP stub（`tests/setup.ts` 的 `stub()`），
并在测试进程里显式打开 `MODEL_CALLS_ENABLED` / `COLLECT_ENABLED`；生产与本地运行时这两个开关仍是关闭的。

本模块自己的模型调用（F06 起）同样只在测试里指向 stub，不读真实 `LLM_API_KEY`。

## 6. 常见卡点

- `EBADENGINE` 或语法报错：Node 版本不对，`node -v` 应为 24.22.2。
- 测试提示要求 `_test`/`_ci` 库：`DATABASE_URL` 的库名不对。
- `npm ci` 卡住：先确认能访问 npm registry；本机若需代理，给 npm 单独配置，不要改仓库文件。
- 国内网络访问 GitHub 失败：给 git 单独配置代理（`git config http.https://github.com.proxy ...`），
  不要把代理写进仓库配置或提交 `.env`。
