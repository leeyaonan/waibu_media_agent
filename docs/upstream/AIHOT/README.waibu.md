# AIHOT 上游原件（只读）

本目录保存引入源码的上游文档原件，供追溯与升级比对，不参与运行。

## 来源

- 仓库：<https://github.com/KKKKhazix/AIHOT>
- commit：`cd424b0a513c7c8535b6f291b106a3086d6b75bf`
- 许可：MIT（见仓库根 `LICENSE`）；**AIHOT 品牌名称与 Logo 不在该许可内**，见根 `NOTICE`。

## 内容

| 路径 | 说明 |
|---|---|
| `README.md`、`README.en.md` | 上游中英文说明原件 |
| `AGENTS.upstream.md`、`CLAUDE.upstream.md` | 上游 AI 协作配置说明。**只作文档保存，不启用、不覆盖本项目 `AGENTS.md`。** 已改名：原名会被开发工具当作生效规则自动加载。 |
| `CONTRIBUTING.md`、`SECURITY.md` | 上游贡献与安全说明 |
| `architecture.md`、`customize.md`、`deploy.md`、`grouping.md`、`selection.md`、`sources.md`、`story-digest-evaluation.md` | 上游 `docs/` 原件 |
| `assets/`、`examples/` | 上游文档配图与示例数据 |
| `import-manifest.json` | 导入清单：686 个上游跟踪文件的去向与 SHA-256 |

## 规则

1. 本目录内容不修改。需要引用时按路径读取。
2. 开发规则以仓库根 `AGENTS.md` 为准，上游 `AGENTS.md` 与本项目冲突时不生效。
3. 引擎源码导入在仓库根目录，保留上游 monorepo 布局；歪布业务在 `modules/waibu-editorial/`。
4. 升级上游时先取新旧两个固定 commit 的 diff，比对 `import-manifest.json` 与本地改动，再在升级分支应用并跑回归。
