# 给 OpenCode / DSH 等实现 Agent

## 可直接使用的任务提示词

> 你在 waibu_media_agent 仓库实施公众号写作 Agent。先读 AGENTS.md、README.md 和 docs/project/02-design.md，再完整读取 outputs/2026-11-05-plan/waibu_media_agent_功能实施计划.xlsx 的五张表。
>
> Excel 是功能计划与任务状态的主记录。先验证 task_id 唯一、依赖存在且无环，检查当前 Git 状态和已交付任务，不从零覆盖已有实现。F01–F40 是本期范围，F41–F44 暂不启用。
>
> 作为协调 Agent，你是 Excel 的唯一写入者。按任务表扫描 TODO：全部依赖必须在集成分支 DONE，owner 为空，并与已领取任务没有 lock_key 或 write_paths 冲突。先冻结共享契约，再把互不冲突的任务派给并行执行 Agent；每个执行者使用独立 worktree/feature 分支。禁止多人写同一个 xlsx，禁止二进制合并工作簿。先记录领取人、分支和租约，再派发。
>
> 执行者读取对应功能规格与验收用例，自主实现、测试和修复，提交代码及 docs/task-results/<task_id>.json。你审查结果、合并并在集成分支验证后才将任务改为 DONE；自测完成只表示 REVIEW。接着重新扫描依赖并继续下一批。发现缺陷新增关联 FIX 任务，不降低验收条件。遇到缺凭据或作者材料时标明阻塞原因，继续不受影响的任务。
>
> 真实来源和付费模型开关默认关闭，使用 fixture 开发；不得自动发布公众号、虚构亲测、替作者批准稿件。真实试运行缺运行环境、模型凭据或预算时停在相应门禁，其余开发照常推进。每批结束更新 Excel 与结果证据，汇报已合并、失败和下一批可领取项。

## 读取与字段约定

支持正常 XLSX 读取的工具均可使用。程序定位工作表名和第 5 行字段键，读取第 6 行起的记录；用 task_id 关联规格与验收，不依赖 Excel 行号作为业务 ID。日期型 updated_at、lease_until 按带时区 ISO 8601 文本回填，避免不同机器时区解释不一致。总览日期是 Excel 日期值。

dependency_gate 是方便人工查看的公式结果，只反映依赖；既不表示已领取，也不检查文件锁或租约。调度器必须从 depends_on 和实际 status 重新计算。改依赖或追加任务后同步更新公式和表范围，再验证；不能只改变颜色。

## 单写者与抢占

同机协调者在写工作簿前使用仓库公共位置的原子文件锁（例如 git common dir 下的 taskboard.lock）；写临时文件、验证可读后原子替换，保存 Git 历史。执行者不写 Excel，提交独立结果文件；其分支意外包含工作簿修改时，不合入该二进制变更。

多机器由指定协调者拥有写权限，其余只读和提交结果。租约过期先检查原 Agent 是否仍运行、是否有未提交修改，停止旧任务或保存其分支后再重领。租约不赋予删除其他 Agent 工作的权限。不能同时启动两个没有协调关系的“主协调 Agent”。

## 任务结果格式

以下只是交接数据格式示例，不代表任何任务已完成：

```json
{
  "task_id": "F02",
  "plan_revision": "0.1.0",
  "base_commit": "<集成基线 commit>",
  "branch": "feature/F02-contracts",
  "commits": [],
  "files": [],
  "tests": [{"command": "<实际执行命令>", "exit_code": null, "evidence": "<结果路径或未执行原因>"}],
  "acceptance": [{"case_id": "AC-002", "result": "NOT_RUN", "note": ""}],
  "blockers": [],
  "next_steps": []
}
```

文件路径相对仓库，证据需能在接手环境定位，避免只填某台机器的 /tmp。大体积截图或日志放独立产物存储，结果文件保留位置及 hash；密钥和私人正文不进入证据提交。外部集成不可用时说明实际验证范围。

## 迭代规则

状态流：TODO → CLAIMED → IN_PROGRESS → REVIEW → DONE；失败从 REVIEW 回 IN_PROGRESS，外部阻塞进入 BLOCKED，解阻后由协调者回到 TODO。BACKLOG 只在作者扩大范围后启用。

同一故障两轮未改善时先缩小复现、保存证据并交协调者判断，避免机械重试。新需求、跨模块修复或发现设计冲突时新增 FIX-001 等稳定 ID，写 parent_task_id、依赖、规格、验收和范围。已有 DONE 任务的回归缺陷用 FIX 表达，不抹去其原交付记录。

初始工作簿已检验依赖无环，但执行 Agent 必须在每次计划调整后重新检查；任务表支持排序过滤，ID 不变。最终完成条件是功能代码、验收证据和合并状态一致，不是所有单元格被手工改成 DONE。
