# Mercury Agent 中文文档

> 一个以“灵魂”为中心的 AI Agent，内置权限加固工具、Token 预算、多渠道访问和 SQLite 支持的 Second Brain 记忆。

[English](README.md) | 简体中文

Mercury 会记住重要信息，在执行有风险的操作前先请求确认，并且可以通过 CLI 或 Telegram 以 24/7 后台进程运行。它适合需要本地文件操作、命令执行、长期记忆、定时任务和多模型兜底能力的个人 AI 助手场景。

## 快速开始

直接运行：

```bash
npx @cosmicstack/mercury-agent
```

或全局安装：

```bash
npm i -g @cosmicstack/mercury-agent
mercury
```

首次运行会启动配置向导。你需要输入姓名、模型 API Key，并可选择配置 Telegram Bot Token。之后如需重新配置：

```bash
mercury doctor
```

## 为什么选择 Mercury

- **权限优先**：Shell 命令有阻止列表，文件读写受目录作用域限制，危险操作会进入待审批流程。
- **Second Brain 记忆**：基于 SQLite 和 FTS5 的结构化持久记忆，支持自动提取、相关召回、冲突处理和自动整理。
- **灵魂驱动**：人格由你拥有的 Markdown 文件定义，包括 `soul.md`、`persona.md`、`taste.md` 和 `heartbeat.md`。
- **Token 感知**：内置每日 Token 预算，超过阈值后自动简洁回复，并支持 `/budget` 查看、重置或临时覆盖。
- **实时流式输出**：CLI 支持实时 Token 流和 Markdown 重渲染，Telegram 支持可编辑状态消息。
- **持续运行**：可作为后台守护进程运行，崩溃后自动重启，并支持开机自启、定时任务和主动通知。
- **可扩展**：支持安装社区 Skill、调度 Skill 定时运行，并兼容 [Agent Skills](https://agentskills.io) 规范。
- **子代理**：生成并行 AI 代理并发执行任务。LLM 自动决定何时委托，同进程异步协程，零开销，文件锁保障并发安全。
- **编程模式**：计划优先的工作流，先分析再执行，每一步都有用户确认。
- **Spotify 集成**：通过自然对话控制播放、搜索音乐、管理播放列表。免费账户支持只读功能，播放控制需要 Premium。

## 守护进程模式

推荐使用：

```bash
mercury up
```

该命令会安装系统服务、启动后台守护进程，并确保 Mercury 正在运行。如果 Mercury 已经运行，它只会确认状态并显示 PID。

常用命令：

```bash
mercury restart      # 重启后台进程
mercury stop         # 停止后台进程
mercury start -d     # 后台启动，不安装系统服务
mercury logs         # 查看近期守护进程日志
mercury status       # 查看运行状态
```

系统服务支持：

| 平台 | 方式 | 是否需要管理员权限 |
|------|------|--------------------|
| macOS | LaunchAgent (`~/Library/LaunchAgents/`) | 否 |
| Linux | systemd user unit (`~/.config/systemd/user/`) | 否，开机启动可能需要 linger |
| Windows | Task Scheduler (`schtasks`) | 否 |

## CLI 命令

| 命令 | 说明 |
|------|------|
| `mercury up` | 推荐命令：安装服务、启动守护进程并确保运行 |
| `mercury` | 启动 Agent，等同于 `mercury start` |
| `mercury start` | 前台启动 |
| `mercury start -d` | 后台启动 |
| `mercury restart` | 重启后台进程 |
| `mercury stop` | 停止后台进程 |
| `mercury logs` | 查看近期日志 |
| `mercury doctor` | 重新配置，回车保留现有值 |
| `mercury setup` | 重新运行配置向导 |
| `mercury status` | 查看配置和守护进程状态 |
| `mercury help` | 查看完整手册 |
| `mercury upgrade` | 升级到最新版本 |
| `mercury telegram list` | 查看已批准和待处理的 Telegram 用户 |
| `mercury telegram approve <code\|id>` | 批准配对码或待处理请求 |
| `mercury telegram reject <id>` | 拒绝 Telegram 访问请求 |
| `mercury telegram remove <id>` | 移除已批准用户 |
| `mercury telegram promote <id>` | 将 Telegram 成员提升为管理员 |
| `mercury telegram demote <id>` | 将 Telegram 管理员降级为成员 |
| `mercury telegram reset` | 清空 Telegram 访问状态并重新开始 |
| `mercury service install` | 安装开机自启系统服务 |
| `mercury service uninstall` | 卸载系统服务 |
| `mercury service status` | 查看系统服务状态 |
| `mercury --verbose` | 使用调试日志启动 |

## 对话内命令

这些命令可在 CLI 或 Telegram 对话中输入，不消耗 API Token。

| 命令 | 说明 |
|------|------|
| `/help` | 查看完整手册 |
| `/status` | 查看 Agent 配置、预算和用量 |
| `/tools` | 列出已加载工具 |
| `/skills` | 列出已安装 Skill |
| `/stream` | 切换 Telegram 文本流式输出 |
| `/stream off` | 关闭流式输出，改为单条消息 |
| `/budget` | 查看 Token 预算状态 |
| `/budget override` | 为单次请求临时覆盖预算 |
| `/budget reset` | 将用量重置为零 |
| `/budget set <n>` | 修改每日 Token 预算 |
| `/permissions` | 修改权限模式 |
| `/tasks` | 列出定时任务 |
| `/memory` | 查看和管理 Second Brain 记忆 |
| `/unpair` | Telegram：重置所有访问 |
| `/agents` | 列出所有子代理（运行中和已完成） |
| `/halt` | 紧急停止：终止所有子代理并清空队列 |
| `/stop` | 终止所有代理、清空队列、释放锁、重置任务板 |
| `/code plan` | 编程模式：仅分析和规划，不作代码修改 |
| `/code execute` | 编程模式：逐步执行计划 |
| `/code off` | 退出编程模式 |
| `/code toggle` | 切换编程模式（关闭 → 规划 → 执行） |
| `/code status` | 显示当前编程模式 |
| `/spotify` | 显示 Spotify 连接状态、账户和订阅计划 |
| `/spotify auth` | 连接 Spotify（浏览器或手动代码） |
| `/spotify code <code>` | 使用授权码完成认证（适用于 SSH/Telegram） |
| `/spotify logout` | 断开 Spotify 并清除保存的令牌 |
| `/spotify player` | 交互式音乐播放器（CLI 方向键控制） |
| `/spotify devices` | 列出可用的 Spotify 设备 |
| `/spotify device <id>` | 设置活跃设备 |
| `/spotify now` | 显示当前正在播放的内容 |

## 内置工具

| 分类 | 工具 |
|------|------|
| 文件系统 | `read_file`, `write_file`, `create_file`, `edit_file`, `list_dir`, `delete_file`, `send_file`, `approve_scope` |
| Shell | `run_command`, `cd`, `approve_command` |
| 消息 | `send_message` |
| Git | `git_status`, `git_diff`, `git_log`, `git_add`, `git_commit`, `git_push` |
| GitHub | `create_pr`, `review_pr`, `list_issues`, `create_issue`, `github_api` |
| Web | `fetch_url` |
| Skills | `install_skill`, `list_skills`, `use_skill` |
| 调度 | `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` |
| 预算 | `budget_status` |
| 子代理 | `delegate_task`, `list_agents`, `stop_agent` |
| 交互 | `ask_user` |
| Spotify | `spotify_search`, `spotify_play`, `spotify_pause`, `spotify_next`, `spotify_previous`, `spotify_now_playing`, `spotify_devices`, `spotify_queue`, `spotify_like`, `spotify_volume`, `spotify_shuffle`, `spotify_repeat`, `spotify_top_tracks`, `spotify_playlists` |

## 渠道

| 渠道 | 能力 |
|------|------|
| CLI | Readline 提示符、方向键命令菜单、实时文本流、Markdown 重渲染、权限模式选择 |
| Telegram | HTML 格式化、可编辑流式消息、文件上传、输入状态、多用户访问和管理员/成员角色 |

### Telegram 访问模型

Mercury 使用组织式访问模型，包含管理员和成员。

- 首次设置：向你的 Bot 发送 `/start`，获取配对码，然后在 CLI 中执行 `mercury telegram approve <code>`。你会成为首位管理员。
- 新用户：发送 `/start` 请求访问，由管理员在 CLI 中批准或拒绝。
- 角色：管理员可以批准、拒绝、提升、降级和重置访问；成员可以与 Mercury 对话。
- 重置：管理员可在 Telegram 发送 `/unpair`，或在 CLI 中执行 `mercury telegram reset`。
- 仅支持私聊，群聊消息会被忽略。

## 调度器

- **周期任务**：使用 cron 表达式，例如 `0 9 * * *` 表示每天 9 点。
- **一次性任务**：使用 `delay_seconds`，例如 15 秒后执行。
- 任务会持久化到 `~/.mercury/schedules.yaml`，重启后自动恢复。
- 执行结果会返回到创建任务时所在的渠道。

## Second Brain

Mercury 默认启用结构化持久记忆，并会在对话后自动提取、存储和召回与你有关的重要事实。

- 10 种记忆类型：identity、preference、goal、project、habit、decision、constraint、relationship、episode、reflection。
- 自动提取：每轮对话后提取 0 到 3 条事实，并记录置信度、重要性和持久性。
- 相关召回：每次消息前注入最相关的前 5 条记忆，默认预算 900 字符。
- 自动整理：每 60 分钟生成个人资料摘要、活跃状态摘要和反思。
- 冲突处理：按置信度和时间新旧处理相互冲突的记忆。
- 自动修剪：活跃作用域记忆 21 天后过期，推断记忆会衰减，低置信持久记忆 120 天后撤销。
- 用户控制：通过 `/memory` 查看、搜索、暂停、恢复和清空。
- 禁用方式：设置 `SECOND_BRAIN_ENABLED=false`，或在配置中设置 `memory.secondBrain.enabled: false`。

所有数据都保存在本机 `~/.mercury/memory/second-brain/second-brain.db`，不会上传到云端。

## 子代理（Sub-Agents）

Mercury 不仅仅是一个聊天机器人——它是一个**编排器**。它可以生成并行的 AI 代理来同时处理多个任务，同时继续自己的对话。

### 为什么这很重要

传统 AI 代理是单线程的：一个上下文窗口，一次一个任务。子代理打破了这种限制：

- **并行执行** — 研究、编码和审查同时在隔离的上下文窗口中运行
- **LLM 驱动的委托** — 模型自身根据任务复杂度决定何时委托
- **同进程协程** — 零启动开销，共享内存，任务完成时即时通知
- **文件锁** — 读写锁防止代理之间的并发写入冲突
- **资源感知** — 最大并发代理数根据 CPU/RAM 自动检测，无需配置

### 工作原理

```
你: "帮我建一个 REST API 并写测试"
  Mercury 决定委托:
  ├─ delegate_task("构建 REST API 端点")  → 代理 a1
  └─ delegate_task("编写集成测试")        → 代理 a2（排队等待）
  
  结果:
  ✓ a1 已完成: "REST API 已构建，5 个端点"
  ✓ a2 已完成: "12 个集成测试全部通过"
```

使用 `/agents` 监控，紧急停止用 `/halt` 或 `/stop`。

## 编程模式

一种计划优先的工作流，强制 Mercury 在写代码之前先进行分析。

| 模式 | 行为 |
|------|------|
| **Off（关闭）** | 正常对话 |
| **Plan（规划）** | Mercury 分析并提出计划——不做代码修改 |
| **Execute（执行）** | Mercury 逐步执行计划并验证 |

```
/code plan      → Mercury 读取你的代码库并提出计划
/code execute   → Mercury 实施计划，验证构建/测试
/code off       → 回到普通对话
```

`ask_user` 工具让 Mercury 在决策点展示选项，CLI 中是方向键菜单，Telegram 中是内联按钮。

## Spotify 集成

通过自然对话控制你的 Spotify。播放音乐、管理播放列表、跳过曲目、调整音量——全部在你的设备上操作。

### 设置

1. 在 [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) 创建一个 Spotify 应用
2. 将重定向 URI 设置为 `http://127.0.0.1:8888/callback`
3. 运行 `mercury doctor` → Spotify 选择**是** → 输入 Client ID 和 Secret
4. 启动 Mercury 并运行 `/spotify auth`

### 免费版与 Premium 功能对比

| 功能 | 免费版 | Premium |
|------|--------|---------|
| 搜索曲目、艺人、专辑 | ✅ | ✅ |
| 查看正在播放 | ✅ | ✅ |
| 列出设备 | ✅ | ✅ |
| 你的热门曲目和播放列表 | ✅ | ✅ |
| 喜欢/保存曲目 | ✅ | ✅ |
| 播放/暂停/跳过/音量 | ❌ | ✅ |
| 队列、随机播放、重复 | ❌ | ✅ |

直接说"播放一些轻松的音乐"或"我的热门曲目是什么？"——Mercury 会处理其余的。

## 配置位置

运行时数据保存在 `~/.mercury/`，不会写入你的项目目录。

| 路径 | 用途 |
|------|------|
| `~/.mercury/mercury.yaml` | 主配置，包括提供商、渠道和预算 |
| `~/.mercury/.env` | API Key 和 Token |
| `~/.mercury/soul/*.md` | Agent 人格文件 |
| `~/.mercury/permissions.yaml` | 能力和审批规则 |
| `~/.mercury/skills/` | 已安装 Skill |
| `~/.mercury/schedules.yaml` | 定时任务 |
| `~/.mercury/token-usage.json` | 每日 Token 用量 |
| `~/.mercury/memory/short-term/` | 每段对话的短期记忆 JSON 文件 |
| `~/.mercury/memory/long-term/` | 自动提取事实，JSONL 格式 |
| `~/.mercury/memory/episodic/` | 带时间戳的事件日志，JSONL 格式 |
| `~/.mercury/memory/second-brain/` | 结构化记忆数据库 |
| `~/.mercury/daemon.pid` | 后台进程 PID |
| `~/.mercury/daemon.log` | 守护进程日志 |

## 模型提供商兜底

Mercury 可以配置多个 LLM 提供商，并按顺序自动尝试。如果某个提供商失败，会切换到下一个。

| 提供商 | 默认模型 | API Key | 说明 |
|--------|----------|---------|------|
| DeepSeek | `deepseek-chat` | `DEEPSEEK_API_KEY` | 默认、成本较低 |
| OpenAI | `gpt-4o-mini` | `OPENAI_API_KEY` | 支持 GPT-4o、o3 等 |
| Anthropic | `claude-sonnet-4` | `ANTHROPIC_API_KEY` | Claude Sonnet、Haiku、Opus |
| Grok (xAI) | `grok-4` | `GROK_API_KEY` | OpenAI 兼容接口 |
| Ollama Cloud | `gpt-oss:120b` | `OLLAMA_CLOUD_API_KEY` | 远程 Ollama API |
| Ollama Local | `gpt-oss:20b` | 无需 Key | 本地 Ollama 实例 |

## 架构

- TypeScript + Node.js 20+
- Vercel AI SDK v4，支持 `generateText`、`streamText` 和多步 Agent 循环
- 子代理编排：同进程异步协程、文件锁、资源感知并发
- grammY Telegram Bot
- SQLite + FTS5 Second Brain
- Spotify Web API：OAuth2 浏览器+手动认证、令牌刷新、14 个播放和库工具
- JSONL 短期、长期和情景记忆
- 后台守护进程、PID 文件和崩溃恢复
- macOS、Linux、Windows 系统服务

## 参与贡献

欢迎贡献修复、工具、记忆能力、渠道能力或文档改进。请保持 PR 聚焦，并在提交前运行：

```bash
npm install
npm run build
```

贡献 Mercury 时请特别注意：

- 工具必须走权限系统，不能绕过审批。
- 面向 Agent 循环设计，尽量保持幂等。
- 避免冗长输出和过度日志，Token 预算是核心约束。
- CLI 和 Telegram 行为应尽量一致。
- 新增依赖、破坏性变更和 soul/persona 系统调整应先讨论。

## 许可证

MIT © [Cosmic Stack](https://github.com/cosmicstack-labs)

## 社区

- Discord：[加入 Mercury Agent Discord](https://discord.gg/5emMpMJy5J)
- 邮箱：[mercury@cosmicstack.org](mailto:mercury@cosmicstack.org)

## 免责声明

这是 AI 软件，可能出现错误。请自行评估风险后使用。
