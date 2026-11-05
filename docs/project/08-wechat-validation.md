# 微信结构验证：工具锁定与判定口径

## 锁定的工具

| 项目 | 值 |
| --- | --- |
| npm 包 | `verify-article-structure@0.2.28`（`--save-exact` 精确锁定） |
| 规范仓 | [wechatjs/verify-article-structure-spec](https://github.com/wechatjs/verify-article-structure-spec) `6bc3ea1ac079cccd88824715c879eb637f1ab076`（2026-11-05） |
| 许可 | MIT |
| 运行方式 | CLI：`node node_modules/verify-article-structure/dist/src/cli.js check <file> --json` |
| 浏览器 | Puppeteer 驱动真实 Chromium；通过 `PUPPETEER_EXECUTABLE_PATH` 复用镜像里的 Chromium |

选它而不是自己写规则的原因：布局类规则（宽度差异、`height:0`、行高叠字）
必须用真实浏览器的 `getBoundingClientRect` 测量，jsdom 做不了。

## 判定口径

- 退出码 0 且 `isValid: true` → `passed`
- 退出码 1 或 `isValid: false` → `failed`，保存违规规则名与原文
- 校验器自身出错（浏览器起不来、输出不可解析、超时）→ `validator_error`

**`validator_error` 不等于通过。** 导出闸门 `assertRevisionValidated`
对三种情况分别拦截：没有记录、`failed`、`validator_error`。

## 三块状态分开记

报告里固定保存三块，互不覆盖：

| 块 | 含义 | 谁填 |
| --- | --- | --- |
| `local` | 我们自己的结构自检（无脚本、无固定像素宽、图片带原始宽高） | 导出前自检 |
| `official` | 官方校验器结果 | 本模块 |
| `wechat_backend` | 公众号后台的实际效果 | 恒为 `unverified`，只能由作者粘贴后目视确认 |

把后台状态写成 `unverified` 是刻意的：**我们无法自动验证公众号后台的最终渲染**，
任何“已验证后台效果”的说法都是假的。

## 实测发现（写进验收证据）

官方 `width` 规则拦的不是“任何固定宽度”：

| 写法 | 官方判定 |
| --- | --- |
| `<section style="width:900px">` | **通过** |
| `<p style="margin-left:600px">` | 违规 `width` |
| `<table>` 固定 800px 列宽 | 违规 `width` |
| `<img style="opacity:0">` | 违规 `opacity` |
| `<pre>` 超宽不换行 | 违规 `pre` |
| `line-height:0` 多行文字 | 违规 `line-height` |

所以“故意加固定宽度让校验失败”这条验收，用的是 `margin-left:600px`，
而不是单纯 `width:900px`——后者官方本来就不拦。

## 当前实现的位置与后续

校验接口 `POST /api/admin/editorial/drafts/:id/validate` 目前在 API 进程内同步执行
（一次约 1–3 秒）。F37 总装时应改成 worker 任务，避免 API 进程被浏览器拖住。
导出闸门已经就位，与执行位置无关。
