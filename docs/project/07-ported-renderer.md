# 移植记录：公众号正文渲染器

## 来源

- 本机技能：`~/.agents/skills/waibu-wechat-official-account-article/scripts/render_article.py`
- 版本：2026-11 技能包（作者维护版，`render_article.py` 116 行）
- 移植时间：2026-11-05

## 为什么移植而不是调用

仓库必须在没有作者电脑、没有 Codex 技能目录的服务器上独立运行。
产品代码不能依赖 `~/.agents/skills/` 是否存在，所以规则逐条搬进
`modules/waibu-editorial/backend/render/index.ts`，用测试锁住行为。

## 保留了哪些规则

| 规则 | 说明 |
| --- | --- |
| 一级标题不进正文 | 标题是发布元数据，复制内容里不能出现 |
| 正文禁止超链接 | 公众号会吞或改写链接，来源改成普通文字归属，URL 进素材清单 |
| 不支持语法明确报错 | 围栏代码、表格、嵌套列表、原始 HTML 一律拒绝，不产出错版 |
| 图片单独成段 | 与前后文字混排直接报错 |
| 图片按原始比例自适应 | 输出 `width:100%;max-width:100%;height:auto` 与 `data-w`/`data-ratio`/`data-type`，不写死像素宽 |
| 段落包 span | 微信对段落内裸文本的对齐处理不稳定 |
| 纯文字同源 | 由同一份 Markdown 生成，图片转成「【配图：说明】」 |

## 与技能版的差异

- 技能版用 Pillow 读本地图片尺寸；这里复用模块自己的字节解析（`backend/assets`），不引入 Python。
- 技能版输出本地文件路径；这里输出私有素材接口 URL（`/api/admin/editorial/assets/:id/content`），
  页面与导出包都能用，且未登录读不到图。
- 技能版额外产出「离线预览」「渲染清单」等文件；这些由导出包任务（F34）负责组装。

## 未移植

- 技能里的品牌色与字体常量按本仓库 `apps/web/app/app.css` 的变量重写，不复制技能配色。
- 技能中的 `wechat-copy.js` 剪贴板脚本由 F32 在我们的页面内实现，不直接搬技能脚本。

## 验证

`modules/waibu-editorial/tests/render.test.ts` 13 项：
标题不进正文、链接拒绝、裸 URL 保留、嵌套列表与代码块/表格拒绝、
GIF 自适应与原始比例、图片缺失报错、图片必须单独成段、长段落与中英混排、
粗体/行内代码/引用、无脚本与内部编号、纯文字内容一致、同输入同输出。
