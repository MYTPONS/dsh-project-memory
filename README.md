# dsh-project-memory

**DSH 专属工具** · [English](#english)

给每个项目建立一份可检索、可恢复、可提交的持久记忆：记录、日志、文档和功能清单。

> 当前发布渠道是本 GitHub 仓库 / 本地 DSH bundle。npm 上的同名包与本仓库不是同一个实现，本仓库不发布 npm。

## 为什么需要它

Agent 经常记得“这次会话里发生了什么”，但下一个会话就忘了：

- 上次为什么选了这个方案；
- 哪条需求已经确认、哪条还没做；
- 现在项目做到哪一步；
- 规范、方向、命令和坑写在哪里。

`dsh-project-memory` 把这些内容从聊天上下文搬到项目工作区，并保持一份权威主存档：

```text
<项目根>/.dsh/
  records/YYYY-MM-DD.md
  logs/YYYY-MM-DD.md
  docs/*.md
  docs/features.md
  META.json

<DSH_HOME>/project-memory/<projectKey>/
  records/YYYY-MM-DD.md
  logs/YYYY-MM-DD.md
  docs/*.md
  docs/features.md
  META.json
```

项目级 `.dsh` 方便随项目查看和提交；主存档是权威副本，项目级目录被删后可以用 `project_restore` 重建。

## 设计原则

- **模型只说记什么**：日期、路径、文件名、双写和备份由插件决定。
- **主存档为权威**：项目级目录丢失时，可从主存档恢复。
- **记录与过程分离**：`record` 存结论/决定，`log` 存过程事件，`doc` 存背景/规范。
- **功能清单可核对**：使用 Markdown checkbox，不依赖模型记忆。
- **检索有界**：关键词 + 日期窗口，返回少量命中行，避免把整个历史塞进上下文。
- **覆盖前先备份**：覆盖/删除文档或重写功能清单时，备份到系统临时目录。
- **默认不推送**：`project_git` 默认只提交；`push=true` 才推送。
- **删除必须显式确认**：`project_forget` 要求 `confirm=true`。

## 安装

需要 DSH（DeepSeek Harness）和 Node.js 22+。

```bash
git clone https://github.com/MYTPONS/dsh-project-memory.git
pnpm install --frozen-lockfile
```

从本地目录作为 DSH bundle 安装：

1. 打开 DSH 的 **Plugins** 页面；
2. 选择 **Add plugin**，指向本仓库目录；
3. 启用 `project-memory` 行；
4. 新开会话，确认工具列表出现 `project_*`。

也可以使用已安装的 `dsh` CLI：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-project-memory
```

## 工具

| 工具 | 作用 |
|---|---|
| `project_status` | 查看项目根、两份 store、备份配置、最近记录与文档概览 |
| `project_write` | 写 `record` / `log`，自动加时间戳并双写 |
| `project_read` | 按日期/区间直接读取记录或日志 |
| `project_doc` | 文档 `list/read/write/append/delete` |
| `project_feature` | 功能清单 `list/add/check/uncheck/remove` |
| `project_search` | 关键词 + 日期窗口检索；支持跨项目 |
| `project_git` | `commit/status/log/diff`；默认不推送 |
| `project_archive` | 列出主存档中的所有项目 |
| `project_restore` | 从主存档恢复项目级 `.dsh`，只补缺失文件 |
| `project_forget` | 删除某项目主存档，必须 `confirm=true` |

所有工具都支持 `project=` 指定目标项目根，默认使用当前会话工作目录。

## 常见用法

```text
project_write(kind=record, title="完成登录链路",
              content="决定：token 放 HttpOnly cookie；刷新窗口 15 分钟。")

project_write(kind=log, content="已运行 pnpm verify")

project_doc(action=write, name=direction,
            content="# 项目方向\n\n先完成核心闭环，再做 UI。")

project_feature(action=add, items=["登录", "导出"])
project_feature(action=check, item="登录")

project_read(date="2026-11-26", days=1)
project_search(query="token", kind=record, days=7)
```

## 配置

`cordis.patch.yml` 可覆盖以下配置：

| 键 | 默认 | 说明 |
|---|---|---|
| `mainDir` | `<DSH_HOME>/project-memory` | 主存档根 |
| `backupMode` | `docs-only` | `off` / `docs-only` / `all` |
| `backupMaxPerFile` | `6` | 每个文件最多保留备份数 |
| `backupTempDir` | `<tmp>/dsh-project-memory/backups` | 临时备份目录 |
| `gitEnabled` | `true` | 是否允许 `project_git` |
| `timeZone` | `Asia/Shanghai` | 记录时间戳时区 |
| `maxEntryBytes` | `120000` | 单条记录上限 |
| `searchLimitDefault` | `20` | 默认检索条数 |
| `autoRestore` | `false` | 项目级 `.dsh` 缺失时是否自动回灌 |
| `detectRoot` | `false` | 是否从 cwd 向上探测项目根 |
| `rootMarkers` | `.git/.dsh/package.json` | 项目根标记 |
| `scaffoldDocs` | `false` | 首次建档是否创建方向/功能模板 |

`backupMode=all` 预留了更广的备份策略；当前追加型记录/日志仍保持不备份，文档覆盖、删除和功能清单重写会备份。

## 安全与数据处理

- `.dsh/` 可能包含项目内部决策、路径和日志；本项目默认把它加入 `.gitignore`，是否提交由你决定。
- 不要把真实凭据、Cookie、私钥或个人数据写进 `record` / `log` / `doc`。
- `project_git` 可能执行 `git add -A`；需要更小范围时传 `files` 或 `addAll=false`。
- `project_restore` 以主存档为准，只补项目级缺失文件，不覆盖项目级已有文件。
- `project_forget` 是破坏性操作，只删除主存档，不删除项目级 `.dsh`。
- 公开仓库只包含代码与合成测试数据，不包含任何真实项目记忆。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm verify
```

测试覆盖工具注册、双写、文档备份与回退、功能清单、检索、恢复、档案删除和临时 git 仓库提交。

## License

MIT。见 [LICENSE](LICENSE)。

---

## English

**DSH-exclusive tool.**

`dsh-project-memory` gives DSH a persistent per-project memory layer: timestamped records and logs, project docs, a Markdown feature checklist, bounded search, an authoritative main archive, and explicit restore/forget operations.

It is a DSH bundle, not a generic note-taking service. Install the repository directory from DSH **Plugins → Add plugin**, or use the local `dsh plugin add` command. Run `pnpm verify` for the no-network test suite.
