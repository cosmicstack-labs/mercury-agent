# Mercury — 以灵魂驱动的 AI Agent

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/img/card-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/img/card-light.png">
    <img alt="Mercury — Soul-Driven AI Agent" src="docs/img/card-light.png" width="600">
  </picture>
</p>

<p align="center">
  <strong>以灵魂驱动、内置权限加固工具、Token 预算和多渠道访问的 AI Agent。</strong>
</p>

<p align="center">
  记住重要信息。行动前先请求确认。通过 CLI 或 Telegram 全天候运行。31 个内置工具、可扩展的 Skills、基于 SQLite 的第二大脑记忆。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cosmicstack/mercury-agent"><img src="https://img.shields.io/npm/v/@cosmicstack/mercury-agent" alt="npm"></a>
  <a href="https://github.com/cosmicstack-labs/mercury-agent"><img src="https://img.shields.io/github/license/cosmicstack-labs/mercury-agent" alt="license"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/@cosmicstack/mercury-agent" alt="node"></a>
</p>

<p align="center">
  <strong>🔖 当前稳定版：v1.1.6</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

---

## 快速开始

```bash
npx @cosmicstack/mercury-agent
```

或全局安装：

```bash
npm i -g @cosmicstack/mercury-agent
mercury
```

首次运行会触发设置向导（姓名、Provider、可选 Telegram）。设置完成后，Mercury 打开 Ink TUI 启动画面，并在聊天开始前请求权限模式（`Ask Me` 或 `Allow All`）。

之后重新配置（更改 key、名称、设置）：

```bash
mercury doctor
mercury doctor --platform
```

## 为什么选择 Mercury？

每个 AI Agent 都能读写文件、运行命令和获取 URL。大多数默默做这些事。**Mercury 先询问 — 并且记住重要的事。**

- **权限加固** — Shell 黑名单（`sudo`、`rm -rf /` 等永不执行）。目录级读/写作用域。待批准流程。会话级"问我"或"全部允许"。无意外。
- **第二大脑** — 基于 SQLite + FTS5 全文搜索的持久化结构化记忆。10 种记忆类型、自动提取、冲突解决、自动整合。Mercury 无需手动输入即可学习你的偏好、目标和习惯。
- **灵魂驱动** — 人格由你拥有的 Markdown 文件定义（`soul.md`、`persona.md`、`taste.md`、`heartbeat.md`）。无企业包装。
- **Token 感知** — 每日预算强制执行。超过 70% 时自动简洁。`/budget` 命令查看、重置或覆盖。
- **实时流式输出** — CLI 实时 Token 流式输出，带光标保存/恢复和 markdown 重渲染。Telegram 流式输出配合可编辑状态消息。
- **全天候运行** — 在任何操作系统上作为后台守护进程运行。崩溃后自动重启。开机自启。Crontab 调度、心跳监控和主动通知。
- **可扩展** — 一条命令安装社区 Skills。将 Skills 调度为循环任务。基于 [Agent Skills](https://agentskills.io) 规范。

Mercury 现在在首次运行时在 `~/.mercury/skills/web-search/SKILL.md` 中植入默认 `web-search` Skill。

## 守护进程模式

**一条命令让 Mercury 持久化：**

```bash
mercury up
```

这会安装系统服务（如果未安装）、启动后台守护进程，并确保 Mercury 正在运行。将此作为你的常用命令。

如果 Mercury 已在运行，`mercury up` 仅确认状态并显示 PID。

### 其他守护进程命令

```bash
mercury restart      # 重启后台进程
mercury stop         # 停止后台进程
mercury start -d     # 后台启动（不安装服务）
mercury logs         # 查看近期守护进程日志
mercury status       # 显示守护进程是否运行
```

守护进程模式内置崩溃恢复 — 如果进程崩溃，它会自动重启并使用指数退避（最高每分钟 10 次重启）。

### 系统服务（开机自启）

`mercury up` 自动安装此服务。你也可以直接管理它：

```bash
mercury service install
```

| 平台 | 方式 | 需要管理员 |
|------|------|-----------|
| **macOS** | LaunchAgent (`~/Library/LaunchAgents/`) | 否 |
| **Linux** | systemd user unit (`~/.config/systemd/user/`) | 否（开机自启可能需要 linger） |
| **Windows** | Task Scheduler (`schtasks`) | 否 |

```bash
mercury service status     # 检查服务是否运行
mercury service uninstall  # 移除系统服务
```

在守护进程模式下，Telegram 成为主要渠道 — CLI 是纯日志，因为没有终端输入。

## CLI 命令

| 命令 | 描述 |
|------|------|
| `mercury up` | **推荐。** 安装服务 + 启动守护进程 + 确保运行 |
| `mercury` | 启动 Agent（等同于 `mercury start`） |
| `mercury start` | 前台启动 |
| `mercury start -d` | 后台启动（守护进程模式） |
| `mercury restart` | 重启后台进程 |
| `mercury stop` | 停止后台进程 |
| `mercury logs` | 查看近期守护进程日志 |
| `mercury doctor` | 重新配置（姓名、Provider、渠道、权限默认项） |
| `mercury doctor --platform` | 显示跨平台终端/守护进程兼容性诊断 |
| `mercury setup` | 重新运行设置向导 |
| `mercury status` | 显示配置和守护进程状态 |
| `mercury help` | 显示完整手册 |
| `mercury upgrade` | 升级到最新版本 |
| `mercury telegram list` | 列出已批准和待处理的 Telegram 用户 |
| `mercury telegram approve <code\|id>` | 批准配对码或待处理请求 |
| `mercury telegram reject <id>` | 拒绝待处理的 Telegram 访问请求 |
| `mercury telegram remove <id>` | 移除已批准的 Telegram 用户 |
| `mercury telegram promote <id>` | 将 Telegram 成员晋升为管理员 |
| `mercury telegram demote <id>` | 将 Telegram 管理员降级为成员 |
| `mercury telegram reset` | 清除所有 Telegram 访问并重新开始 |
| `mercury service install` | 安装为系统服务（开机自启） |
| `mercury service uninstall` | 卸载系统服务 |
| `mercury service status` | 显示系统服务状态 |
| `mercury --verbose` | 使用调试日志启动 |

## 对话内命令

在对话中输入这些 — 它们不消耗 API Token。CLI 和 Telegram 都适用。

| 命令 | 描述 |
|------|------|
| `/help` | 显示完整手册 |
| `/status` | 显示 Agent 配置、预算和用量 |
| `/tools` | 列出所有已加载的工具 |
| `/skills` | 列出已安装的 Skills |
| `/stream` | 切换 Telegram 文本流式输出 |
| `/stream off` | 禁用流式输出（单条消息） |
| `/budget` | 显示 Token 预算状态 |
| `/budget override` | 单次请求覆盖预算 |
| `/budget reset` | 将用量重置为零 |
| `/budget set <n>` | 更改每日 Token 预算 |
| `/permissions` | 更改权限模式（问我 / 全部允许） |
| `/view` | 切换进度视图（平衡 / 详细） |
| `/view balanced` | 设置精简进度视图 |
| `/view detailed` | 设置完整进度视图 |
| `/code agent <task>` | 将编码任务委托给后台子 Agent |
| `/ws exit` | 退出工作区 IDE 模式回到常规聊天 |
| `/tasks` | 列出调度任务 |
| `/memory` | 查看和管理第二大脑记忆 |
| `/unpair` | Telegram：重置所有访问 |

## 内置工具

| 分类 | 工具 |
|------|------|
| **文件系统** | `read_file`、`write_file`、`create_file`、`edit_file`、`list_dir`、`delete_file`、`send_file`、`approve_scope` |
| **Shell** | `run_command`、`cd`、`approve_command` |
| **消息** | `send_message` |
| **Git** | `git_status`、`git_diff`、`git_log`、`git_add`、`git_commit`、`git_push` |
| **Web** | `fetch_url` |
| **Skills** | `install_skill`、`list_skills`、`use_skill` |
| **调度器** | `schedule_task`、`list_scheduled_tasks`、`cancel_scheduled_task` |
| **系统** | `budget_status` |

## 渠道

| 渠道 | 特性 |
|------|------|
| **CLI** | Ink TUI、启动权限模式选择器、交互式权限提示（方向键 + Enter；Y/N/A 快捷键）、进度视图（平衡/详细）、实时流式输出 |
| **Telegram** | HTML 格式化、可编辑流式消息、文件上传、输入状态指示器、多用户访问与管理员/成员角色 |

### 工作区/编码快捷键（CLI）

- `Ctrl+P` → 切换到计划模式
- `Ctrl+X` → 切换到执行模式
- `Esc` 或 `Ctrl+Q` → 退出工作区回到常规聊天
- `Ctrl+V` → 切换进度视图（当终端拦截 Ctrl+V 时 `/view` 作为后备）

### Spotify UI 注意事项（CLI）

- Spotify 面板支持键盘快捷键：`N` 下一曲、`P` 上一曲、`+/-` 音量、`Z` 正在播放。
- 内联专辑封面是可选的且安全屏蔽：
  - 用 `MERCURY_SPOTIFY_ART=1` 启用
  - 目前仅在本地 iTerm 会话中渲染
  - 在 SSH/移动端/轻量终端中自动回退到纯文本 UI

### Telegram 访问

Mercury 使用**组织访问模型**，包含管理员和成员。

- **首次设置：** 向你的 Bot 发送 `/start`，收到配对码，然后在 CLI 中输入 `mercury telegram approve <code>`。你成为首位管理员。
- **其他用户：** 发送 `/start` 请求访问。管理员从 CLI 批准或拒绝。
- **角色：** 管理员可以批准/拒绝请求、晋升/降级用户和重置访问。成员可以与 Mercury 聊天。
- **重置：** 管理员可以在 Telegram 发送 `/unpair`，或在 CLI 中运行 `mercury telegram reset` 清除所有访问并重新开始。
- 仅限私聊 — 群组消息始终被忽略。

CLI 命令：`mercury telegram list|approve|reject|remove|promote|demote|reset`

## 调度器

- **循环**：使用 cron 表达式的 `schedule_task`（`0 9 * * *` 每天 9 点）
- **一次性**：使用 `delay_seconds` 的 `schedule_task`（例如 15 秒）
- 任务持久化到 `~/.mercury/schedules.yaml`，重启后恢复
- 响应路由回创建任务的渠道

## 第二大脑

Mercury 构建一个结构化、持久化的记忆，随每次对话增长。默认启用，自动提取、存储和召回关于你的事实。

- **10 种记忆类型** — identity、preference、goal、project、habit、decision、constraint、relationship、episode、reflection
- **自动提取** — 每轮对话后，Mercury 提取 0–3 条带置信度、重要性和持久性分数的事实
- **相关召回** — 每次消息前，将最匹配的 5 条记忆（900 字符预算）注入上下文
- **自动整合** — 每 60 分钟，Mercury 构建个人资料摘要、活跃状态摘要，并从模式生成反思
- **冲突解决** — 对立记忆按置信度（更高者胜出）或新旧（更新者胜出）解决
- **自动修剪** — 活跃作用域记忆 21 天后过期；推断记忆会衰减；低置信度持久记忆 120 天后清除
- **用户控制** — `/memory` 用于概览、搜索、暂停、恢复和清除
- **禁用** — `SECOND_BRAIN_ENABLED=false` 环境变量或配置中的 `memory.secondBrain.enabled: false`

所有数据保留在你机器的 `~/.mercury/memory/second-brain/second-brain.db`（SQLite + FTS5）。不上云。

## 配置

所有运行时数据位于 `~/.mercury/` — 不在你的项目目录中。

| 路径 | 用途 |
|------|------|
| `~/.mercury/mercury.yaml` | 主配置（Provider、渠道、预算） |
| `~/.mercury/.env` | API key 和 Token（与项目 .env 一起加载） |
| `~/.mercury/soul/*.md` | Agent 人格（soul、persona、taste、heartbeat） |
| `~/.mercury/permissions.yaml` | 能力和审批规则 |
| `~/.mercury/skills/` | 已安装的 Skills |
| `~/.mercury/schedules.yaml` | 调度任务 |
| `~/.mercury/token-usage.json` | 每日 Token 用量跟踪 |
| `~/.mercury/memory/short-term/` | 每段对话的 JSON 文件 |
| `~/.mercury/memory/long-term/` | 自动提取的事实（JSONL） |
| `~/.mercury/memory/episodic/` | 带时间戳的事件日志（JSONL） |
| `~/.mercury/memory/second-brain/` | 结构化记忆数据库（SQLite + FTS5） |
| `~/.mercury/daemon.pid` | 后台进程 PID |
| `~/.mercury/daemon.log` | 守护进程模式日志 |

## Provider 兜底

配置多个 LLM Provider。Mercury 按顺序尝试并自动兜底：

| Provider | 默认模型 | API Key | 备注 |
|----------|----------|---------|------|
| **DeepSeek** | deepseek-chat | `DEEPSEEK_API_KEY` | 默认，成本效益高 |
| **OpenAI** | gpt-4o-mini | `OPENAI_API_KEY` | GPT-4o、o3 等 |
| **Anthropic** | claude-sonnet-4 | `ANTHROPIC_API_KEY` | Claude Sonnet、Haiku、Opus |
| **Grok (xAI)** | grok-4 | `GROK_API_KEY` | OpenAI 兼容端点 |
| **Ollama Cloud** | gpt-oss:120b | `OLLAMA_CLOUD_API_KEY` | 通过 API 的远程 Ollama |
| **Ollama Local** | gpt-oss:20b | 无需 Key | 本地 Ollama 实例 |

当 Provider 失败时，Mercury 自动尝试下一个。它记住最后一个成功的 Provider，并在下次请求时从那里开始。

> **更多 Provider 即将到来** — Google Gemini、Mistral 等已在路线图上。Mercury 的 OpenAI 兼容架构也支持通过 base URL 配置自定义端点。

## 架构

- **TypeScript + Node.js 18+** — ESM，tsup 构建
- **Vercel AI SDK v4** — `generateText` + `streamText`，10 步 Agent 循环，Provider 兜底
- **grammY** — Telegram Bot，带输入指示器、可编辑流式输出和文件上传
- **SQLite + FTS5** — 第二大脑，带全文搜索、冲突解决、自动整合
- **JSONL** — 短期、长期和情景对话记忆
- **守护进程管理器** — 后台生成 + PID 文件 + 看门狗崩溃恢复
- **系统服务** — macOS LaunchAgent、Linux systemd、Windows Task Scheduler

## 许可证

MIT © [Cosmic Stack](https://github.com/cosmicstack-labs)

---

## 免责声明

**这是 AI 软件 — 有时可能会出问题，请自行评估风险后使用。**

---

## 参与贡献

我们欢迎贡献！Mercury 是为演进而构建的，我们欢迎社区的帮助。无论是修复 bug、添加工具、改善记忆还是改进 soul — 所有高质量的贡献都受欢迎。

### 🎯 Agent 专业知识 — 贡献者必读

Mercury 不只是一个开源项目 — 它是一个**以灵魂驱动的 Agent**，全天候运行，管理权限，记住上下文，并在多个渠道间交互。如果你正在贡献，你必须像 Agent 构建者一样思考，而不只是库贡献者。这些是每个贡献者都应该内化的不可协商的原则：

| 原则 | 含义 |
|------|------|
| 🧠 **以循环思维** | Mercury 在 10 步 Agent 循环中运行。你的工具或功能每轮对话会被调用多次。尽可能保持幂等。 |
| 🔐 **权限优先** | 每个触碰外部世界的行为（文件、shell、网络、git）必须经过权限系统。永远不要假设批准。 |
| 💾 **记忆感知** | 如果你的功能生成关于用户的事实，考虑接入第二大脑。如果它读取用户数据，先检查记忆。 |
| 📏 **Token 意识** | Mercury 有每日 Token 预算。日志、冗长输出和大上下文转储会快速消耗 Token。保持精简。 |
| 🔌 **渠道无关** | 工具应该在 CLI 和 Telegram 上表现一致。不要假设终端、键盘，甚至另一端是人。 |
| 🔁 **优雅降级** | 如果 Provider 失败、工具出错或文件不存在 — Mercury 应该恢复，而不是崩溃。始终处理边缘情况。 |
| 📋 **自文档化** | 你的工具的名称和描述是 Mercury 决定何时使用它的依据。让它们清晰、具体和面向行动。 |
| 🧪 **测试循环，不只是函数** | 在隔离中工作的工具在 Agent 循环中可能失败（例如，返回太多数据，阻塞下一步）。端到端测试。 |

### 代码质量 — 做

| 做 | 为什么 |
|---|--------|
| ✅ 写干净的、可读的带显式类型的 TypeScript | Mercury's codebase 是类型安全的 — 保持这样 |
| ✅ 在公共函数和工具上添加 JSDoc 注释 | 帮助其他贡献者和 Agent 理解意图 |
| ✅ 保持函数小而单一职责 | 更易于测试、审查和推理 |
| ✅ 使用 async/await 而不是原始 Promise | 一致的错误处理和可读性 |
| ✅ 为新工具和记忆功能写测试 | 对 24/7 Agent 来说可靠性很重要 |
| ✅ 遵循现有项目结构（`src/tools/`、`src/memory/`、`src/channels/`） | 保持代码库可导航 |
| ✅ 使用 Agent Skills 规范用于新的基于 skill 的功能 | 确保与 skills 生态系统的兼容性 |
| ✅ 在 PR 描述中记录破坏性变更 | 帮助维护者正确版本管理 |

### 代码质量 — 不做

| 不做 | 为什么 |
|------|--------|
| ❌ 未经讨论不添加依赖 | Mercury 很精简 — 每个依赖增加表面积 |
| ❌ 不硬编码 API key、Token 或路径 | 像代码库其他部分一样使用 config/env 变量 |
| ❌ 不绕过权限系统 | 工具必须先请求再行动 — 这是 Mercury 的核心承诺 |
| ❌ 不在热路径中引入同步/阻塞 I/O | Mercury 是异步优先的，有原因 |
| ❌ 不提交大二进制文件或 secrets | 使用 `.gitignore` 和 env 文件 |
| ❌ 未经讨论不更改 soul/persona 系统 | 它是 Mercury 的核心 — 更改需要谨慎 |
| ❌ 不提交未测试的 Telegram 或守护进程更改 | 这些在合并后很难调试 |
| ❌ 不忽略 Token 预算系统 | 每个工具都应该注意 Token 消耗 |

### 开始

1. Fork 仓库
2. 运行 `npm install`
3. 进行更改
4. 运行 `npm run build` 验证编译
5. 本地使用 `mercury` 测试
6. 打开 PR，清晰描述你更改了什么和为什么

### PR 指南

- 保持 PR 聚焦 — 每个 PR 一个功能/修复
- 在描述中包含前/后行为
- 适当时标记相关 issues
- 对审查反馈响应迅速

### 需要帮助？

打开 issue 或联系 [mercury@cosmicstack.org](mailto:mercury@cosmicstack.org)。我们很友好。

---

## 社区

1. **Discord** — [加入 Mercury Agent Discord](https://discord.gg/5emMpMJy5J) 获取实时聊天、支持和小社区讨论。