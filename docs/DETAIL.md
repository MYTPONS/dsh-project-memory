# 项目操作记忆（dsh-project-memory）

给每个被操作的项目建立一份 `.dsh` 记忆，模型只需说明「记什么」，位置、日期、备份策略由插件自动处理。

## 三类内容，分开存放

| 类型 | 用途 | 位置 |
|---|---|---|
| 记录 record | 做了什么、结论、决定 | `<store>/records/YYYY-MM-DD.md`（Markdown 段落） |
| 日志 log | 过程性事件 | `<store>/logs/YYYY-MM-DD.md`（一行一条） |
| 文档 doc | 项目方向、背景、规范 | `<store>/docs/<name>.md` |
| 功能清单 | 待实现/已实现功能 | `<store>/docs/features.md`（`- [ ]` / `- [x]`） |

`store` 有两份：**项目级** `<项目根>/.dsh` 与 **主存档** `<DSH_HOME>/project-memory/<projectKey>`。主存档是**权威档案**。

## 主目录例外

工作目录是**用户主目录**（其 `.dsh` 就是 DSH 本体）、**DSH 本体目录**本身、或**项目根不存在**时，项目级不落盘，只写主存档。

## 时间与日期

每条记录/日志由插件自动加时间戳（默认 `Asia/Shanghai`）。模型不提供日期，也不用算路径。

## 工具（10 个）

- `project_status(project?)` — 根、两份 store、是否主目录例外、项目根是否存在、项目级 .dsh 是否缺失、`lastUpdated`、最近几条记录标题、文档与功能概览。
- `project_write(kind=record|log, content, title?, tags?, project?)` — 写记录/日志。
- `project_read(kind=record|log|both, date?/from?/to?/days?, limit?, project?)` — 按日期直接读原文，无需关键词。
- `project_doc(action=list|read|write|append|delete, name?, content?, project?)` — 文档；read 项目级缺失回退主存档；write/delete 先备份。
- `project_feature(action=list|add|check|uncheck|remove, items?/item?, project?)` — 功能清单；真正实现后才 check。
- `project_search(query, kind?, date?/from?/to?, days?, limit?, allProjects?, project?)` — 关键词+日期窗口检索；`allProjects=true` 跨所有项目档案。
- `project_git(action=commit|status|log|diff, message?, addAll?, files?, push?, dryRun?, project?)` — commit 默认只提交不推送。
- `project_archive()` — 列出主存档里全部项目档案（根、key、计数、项目根/项目级是否还在）。
- `project_restore(project)` — 以主存档为准重建该项目项目级 `.dsh`（缺 records/logs/docs 自动补齐）；主存档缺失时反向导入。
- `project_forget(project, confirm=true)` — 删除某项目主存档（破坏性，需 confirm）；项目级不动。

**跨项目**：所有工具都接受 `project=`（绝对路径或相对当前目录），可在 A 项目里给 B 项目建档/记录/提交/恢复。
**项目根探测**：`detectRoot=true` 时从 cwd 向上找最近的 `.git`/`.dsh`/`package.json` 作为项目根（默认关，直接用 cwd）。

## 兼容 / 自愈

- 目录、子目录、`META.json` 缺失 → 自动补齐（`ensureStore`）。
- `project_doc read` / `project_feature list` 项目级缺失 → 回退主存档。
- 项目级 `.dsh` 被清 → `project_status` 提示，`project_restore` 重建。
- 项目根不存在 → 只写主存档，`archive` 仍可查；重建根后 `restore` 恢复。
- `scaffoldDocs=true` 时，新项目首次写入会创建 `direction.md` / `features.md` 模板。

## 删除项目后的处理（讨论点）

- **主存档为权威**：删项目/删项目级 `.dsh` 后，历史仍在主存档；`project_archive` 可查。
- 默认**不自动回灌**（`autoRestore:false`），避免复活有意删掉的项目；需要时 `project_restore` 手动重建。
- 彻底清记忆：`project_forget(project, confirm=true)`（只删主存档）。
- 想“下次触碰就自动回灌”：`autoRestore:true`。

## 备份策略

- 追加记录 / 日志 → 不备份；git → 不备份。
- 覆盖或删除既有文档 → 才备份；`backupMode` = `off` / `docs-only`（默认）/ `all`。
- 备份写系统临时目录 `<tmp>/dsh-project-memory/backups/`，重启自动清理；每文件保留最近 `backupMaxPerFile`（**默认 6**）份。

## 配置

`mainDir`、`backupMode`、`backupMaxPerFile`（默认 6）、`backupTempDir`、`gitEnabled`、`timeZone`、`maxEntryBytes`、`searchLimitDefault`、`autoRestore`（默认 false）、`detectRoot`（默认 false）、`rootMarkers`、`scaffoldDocs`（默认 false）。

## 已知限制

- 记录按「按天一个文件、追加写入」；检索为机械逐行匹配（有界返回），无全文索引。
- 功能清单以子串匹配；同名条目会一并勾选/取消/删除。
- 主目录例外 / 项目根不存在下不产生项目级副本，是刻意设计。
