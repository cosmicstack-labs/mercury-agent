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

## 守护进程模式

推荐使用：

```bash
mercury up
```

该命令会安装系统服务、启动后台守护进程，并确保 Mercury 正在运行。如果 Mercury 已经运行，它只会确认状态并显示 PID。

守护进程模式包含内置崩溃恢复——如果进程崩溃，会自动重启，采用指数退避策略（最多每分钟 10 次重启）。

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

## 内置工具

| 分类 | 工具 |
|------|------|
| 文件系统 | `read_file`, `write_file`, `create_file`, `edit_file`, `list_dir`, `delete_file`, `send_file`, `approve_scope` |
| Shell | `run_command`, `cd`, `approve_command` |
| 消息 | `send_message` |
| Git | `git_status`, `git_diff`, `git_log`, `git_add`, `git_commit`, `git_push` |
| Web | `fetch_url` |
| Skills | `install_skill`, `list_skills`, `use_skill` |
| 调度 | `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` |
| 系统 | `budget_status` |

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
| MiniMax | `动态获取` | `MINIMAX_API_KEY` | Anthropic 兼容接口，动态获取模型列表 |
| Grok (xAI) | `grok-4` | `GROK_API_KEY` | OpenAI 兼容接口 |
| Ollama Cloud | `gpt-oss:120b` | `OLLAMA_CLOUD_API_KEY` | 远程 Ollama API |
| Ollama Local | `gpt-oss:20b` | 无需 Key | 本地 Ollama 实例 |

## 架构

- **TypeScript + Node.js 18+** — ESM, tsup build
- **Vercel AI SDK v4** — `generateText` + `streamText`，10步 Agentic 循环，提供商兜底
- **grammY** — Telegram Bot，支持打字指示器、可编辑流式消息和文件上传
- **SQLite + FTS5** — Second Brain 全文本搜索、冲突解决、自动整理
- **JSONL** — 短期、长期和情景对话记忆
- **后台守护进程** — 后台生成 + PID 文件 + 看门狗崩溃恢复（指数退避，最多每分钟 10 次重启）
- **系统服务** — macOS LaunchAgent、Linux systemd、Windows Task Scheduler

## 参与贡献

欢迎贡献修复、工具、记忆能力、渠道能力或文档改进。Mercury 是为进化而构建的，我们欢迎社区的帮助。无论是修复 bug、添加工具、改进记忆还是优化灵魂——所有高质量的贡献都会被欣赏。

### Agentic 专业能力 — 贡献者必须具备

Mercury 不只是一个开源项目——它是一个 **灵魂驱动的 Agent**，全天候运行，管理权限、记住上下文并在多个渠道交互。如果你正在贡献，你必须像 Agent 构建者一样思考，而不仅仅是库贡献者。以下是每个贡献者都应该内化的不可协商的原则：

| 原则 | 含义 |
|------|------|
| 🧠 **循环思维** | Mercury 在 10 步 Agentic 循环中运行。你的工具或功能每次对话会被调用多次。尽可能保持幂等。 |
| 🔐 **权限优先** | 每个接触外部世界的操作（文件、Shell、网络、Git）都必须经过权限系统。不要假设会获得批准。 |
| 💾 **内存感知** | 如果你的功能生成了关于用户的事实，考虑接入 Second Brain。如果它读取用户数据，先检查记忆。 |
| 📏 **Token 意识** | Mercury 有每日 Token 预算。日志、冗长输出和大上下文转储会快速消耗 Token。保持精简。 |
| 🔌 **渠道无关** | 工具应该在 CLI 和 Telegram 上行为一致。不要假设有终端、键盘或对面有人。 |
| 🔁 **优雅降级** | 如果提供商失败、工具出错或文件不存在——Mercury 应该恢复，而不是崩溃。始终处理边缘情况。 |
| 📋 **自我文档化** | 你的工具名称和描述是 Mercury 决定何时使用它的依据。让它们清晰、具体和面向行动。 |
| 🧪 **测试循环，而不仅仅是函数** | 一个在孤立状态下工作的工具在 Agentic 循环中可能会失败（例如返回太多数据、阻塞下一步）。端到端测试。 |

### 代码质量 — 应该做

| 应该 | 为什么 |
|------|--------|
| ✅ 编写清晰、可读的 TypeScript，带显式类型 | Mercury's 代码库是类型安全的——保持这种方式 |
| ✅ 在公共函数和工具上添加 JSDoc 注释 | 帮助其他贡献者和 Agent 理解意图 |
| ✅ 保持函数小而单一职责 | 更容易测试、审查和推理 |
| ✅ 使用 async/await 而不是原始 Promise | 一致的错误处理和可读性 |
| ✅ 为新工具和内存功能编写测试 | 对于 24/7 Agent 来说可靠性很重要 |
| ✅ 遵循现有项目结构（`src/tools/`、`src/memory/`、`src/channels/`） | 保持代码库可导航 |
| ✅ 使用 Agent Skills 规范用于新的基于技能的功能 | 确保与技能生态系统的兼容性 |
| ✅ 在 PR 描述中记录破坏性变更 | 帮助维护者正确版本管理 |

### 代码质量 — 不应该做

| 不应该 | 为什么 |
|--------|--------|
| ❌ 未经讨论不要添加依赖 | Mercury 是精简的——每个依赖都增加表面积 |
| ❌ 不要硬编码 API Key、Token 或路径 | 像代码库其他地方一样使用 config/env 变量 |
| ❌ 不要绕过权限系统 | 工具必须先请求再行动——这是 Mercury 的核心承诺 |
| ❌ 不要在热路径中引入同步/阻塞 I/O | Mercury 是异步优先的，有原因 |
| ❌ 不要提交大二进制文件或 secrets | 使用 `.gitignore` 和 env 文件 |
| ❌ 不要在没有讨论的情况下更改 soul/persona 系统 | 它是 Mercury 的核心——更改需要谨慎 |
| ❌ 不要提交未经测试的 Telegram 或守护进程更改 | 这些在合并后很难调试 |
| ❌ 不要忽视 Token 预算系统 | 每个工具都应该注意 Token 消耗 |

### 快速开始

1. Fork 仓库
2. 运行 `npm install`
3. 进行你的更改
4. 运行 `npm run build` 验证编译
5. 本地使用 `mercury` 测试
6. 打开 PR，清晰描述你更改的内容和原因

### PR 指南

- 保持 PR 聚焦——每个 PR 一个功能/修复
- 在描述中包含更改前后的行为
- 如适用，标记相关 issue
- 响应审查反馈

### 需要帮助？

打开 issue 或发送邮件至 [mercury@cosmicstack.org](mailto:mercury@cosmicstack.org)。我们很友好。

## 许可证

MIT © [Cosmic Stack](https://github.com/cosmicstack-labs)

## 社区

- Discord：[加入 Mercury Agent Discord](https://discord.gg/5emMpMJy5J)
- 邮箱：[mercury@cosmicstack.org](mailto:mercury@cosmicstack.org)

## 免责声明

这是 AI 软件，可能出现错误。请自行评估风险后使用。
