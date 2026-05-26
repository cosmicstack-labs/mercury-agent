# Mercury — 架构

> 活文档，随系统演进持续更新。

## 概述

Mercury 是一个以灵魂驱动、Token 高效的 AI Agent，全天候运行。它是一个**编排器**，不仅仅是聊天机器人。它能读写文件、运行命令、执行多步骤 Agent 流程——所有操作均受严格权限系统管控。它通过渠道（CLI、Telegram，未来：Signal、Discord、Slack）通信，并维护持久化记忆。

## 人类类比

| Mercury 概念 | 人类类比 | 文件/模块 |
|---|---|---|
| soul.md | 心脏 | `soul/soul.md` |
| persona.md | 面容 | `soul/persona.md` |
| taste.md | 味觉 | `soul/taste.md` |
| heartbeat.md | 呼吸 | `soul/heartbeat.md` |
| 短期记忆 | 工作记忆 | `src/memory/store.ts` |
| 情景记忆 | 近期经历 | `src/memory/store.ts` |
| 长期记忆 | 人生经验 | `src/memory/store.ts` |
| 第二大脑 | 结构化长期用户模型 | `src/memory/user-memory.ts` + `src/memory/second-brain-db.ts` |
| Providers | 感官 | `src/providers/` |
| Capabilities | 手与工具 | `src/capabilities/` |
| Permissions | 边界 | `src/capabilities/permissions.ts` |
| Channels | 沟通 | `src/channels/` |
| Heartbeat/调度器 | 生物钟 | `src/core/scheduler.ts` |
| 生命周期 | 醒着/睡眠/思考 | `src/core/lifecycle.ts` |
| 子 Agent | 工蜂 | `src/core/sub-agent.ts` + `src/core/supervisor.ts` |
| 文件锁 | 协调 | `src/core/file-lock.ts` |
| 任务板 | 共享状态 | `src/core/task-board.ts` |
| 资源管理器 | 容量规划 | `src/core/resource-manager.ts` |

## 目录结构

```
src/
├── index.ts              # CLI 入口 (commander)
├── channels/             # 通信接口
│   ├── base.ts           # 抽象渠道
│   ├── cli.ts            # CLI 适配器 (readline + 内联权限提示)
│   ├── telegram.ts       # Telegram 适配器 (grammY)
│   └── registry.ts       # 渠道管理器
├── core/                 # 渠道无关的脑子
│   ├── agent.ts          # 多步骤 Agent 循环 (generateText + tools)
│   ├── lifecycle.ts      # 状态机
│   ├── scheduler.ts      # Cron + 心跳
│   ├── sub-agent.ts      # 子 Agent 工作器 (隔离的 Agent 循环)
│   ├── supervisor.ts     # 子 Agent 监督器 (生成/停止/编排)
│   ├── file-lock.ts      # 文件锁管理器 (读写锁)
│   ├── task-board.ts      # 共享任务状态持久化
│   └── resource-manager.ts # 系统资源检测
├── capabilities/         # Agent 工具 & 权限
│   ├── permissions.ts    # 权限管理器 (读写作用域、Shell 黑名单)
│   ├── registry.ts      # 注册所有 AI SDK 工具 + skill/调度器工具
│   ├── filesystem/      # 文件操作：读、写、创建、列表、删除
│   ├── shell/           # Shell 执行（含黑名单）
│   ├── skills/          # Skill 管理工具
│   │   ├── install-skill.ts
│   │   ├── list-skills.ts
│   │   └── use-skill.ts
│   └── scheduler/       # 调度工具
│       ├── schedule-task.ts
│       ├── list-tasks.ts
│       └── cancel-task.ts
│   └── subagents/       # 子 Agent 工具
│       ├── delegate-task.ts
│       ├── list-agents.ts
│       └── stop-agent.ts
├── memory/               # 持久化层
│   ├── store.ts          # 短/长/情景记忆
│   ├── second-brain-db.ts # SQLite 存储引擎 (FTS5)
│   └── user-memory.ts    # 第二大脑：自主结构化记忆
├── providers/            # LLM API
│   ├── base.ts           # 抽象 Provider + getModelInstance()
│   ├── openai-compat.ts
│   ├── anthropic.ts
│   └── registry.ts
├── soul/                 # 意识
│   └── identity.ts       # Soul/persona/taste 加载器 + 护栏
├── skills/               # 模块化能力 (Agent Skills 规范)
│   ├── types.ts          # SkillMeta, SkillDiscovery, Skill 类型
│   ├── loader.ts         # SKILL.md 解析器，渐进式披露
│   └── index.ts          # 桶式导出
├── types/                # 类型定义
└── utils/                # 配置、日志、Token
```

## Agent 循环

Mercury 使用 Vercel AI SDK 的多步 `generateText()` 配合工具：

```
用户消息 → Agent 加载系统提示 (soul + 护栏 + persona)
  → Agent 调用 generateText({ tools, maxSteps: 10 })
    → LLM 决定：回复文本 或 调用工具
      → 如果调用工具：
        → 权限检查 (文件系统作用域 / Shell 黑名单)
        → 如果允许：执行工具，返回结果给 LLM
        → 如果拒绝：LLM 收到拒绝消息，调整方案
        → LLM 继续 (下一步) — 可能调用更多工具或回复
      → 如果文本：最终响应返回给用户
  → Agent 通过渠道发送最终响应
```

## 权限系统

### 文件系统权限（目录级作用域）

- 没有作用域的路径 = **无访问**，必须询问用户
- 用户可授予：`y`（一次性）、`always`（保存到清单）、`n`（拒绝）
- 清单保存在 `~/.mercury/permissions.yaml`
- 可随时编辑 — Mercury 不会绕过

### Shell 权限

- **阻止**（永不执行）：`sudo *`、`rm -rf /`、`mkfs`、`dd if=`、`fork bombs`、`shutdown`、`reboot`
- **自动批准**（无需提示）：`ls`、`cat`、`pwd`、`git status/diff/log`、`node`、`npm run/test`
- **需要批准**：`npm publish`、`git push`、`docker`、`rm -r`、`chmod`、`管道 `curl | sh`
- 命令限制在 CWD + 批准的文件作用域内

### 内联权限 UX

当 Mercury 需要没有的作用域时：
```
  ⚠ Mercury 需要写入 ~/projects/myapp 的权限。允许？(y/n/always):
  > always
  [作用域已保存到 ~/.mercury/permissions.yaml]
```

## 工具

| 工具 | 描述 | 权限检查 |
|---|---|---|
| `read_file` | 读取文件内容 | 路径的读作用域 |
| `write_file` | 写入已有文件 | 路径的写作用域 |
| `create_file` | 创建新文件 + 目录 | 父目录的写作用域 |
| `list_dir` | 列出目录内容 | 路径的读作用域 |
| `delete_file` | 删除文件 | 写作用域，总需确认 |
| `run_command` | 执行 Shell 命令 | 黑名单 + 批准列表 + 作用域 |
| `install_skill` | 从内容或 URL 安装 Skill | 无限制 |
| `list_skills` | 列出已安装的 Skill | 无限制 |
| `use_skill` | 加载并调用 Skill 指令 | 无限制 |
| `schedule_task` | 调度循环 Cron 任务 | 验证 Cron 表达式 |
| `list_scheduled_tasks` | 列出调度任务 | 无限制 |
| `cancel_scheduled_task` | 取消调度任务 | 无限制 |

## Agent 生命周期

```
unborn → birthing → onboarding → idle ⇄ thinking → responding → idle
                                                          ↓
                                            idle → sleeping → awakening → idle
```

## 运行时数据位置

所有运行时数据位于 `~/.mercury/`（而非项目目录）：

| 内容 | 位置 |
|---|---|
| 配置 | `~/.mercury/mercury.yaml` |
| Soul 文件 | `~/.mercury/soul/*.md` |
| 记忆 | `~/.mercury/memory/` |
| Skills | `~/.mercury/skills/` |
| 调度 | `~/.mercury/schedules.yaml` |
| 权限 | `~/.mercury/permissions.yaml` |

## Token 预算

- 系统提示（soul + 护栏 + persona）：每次请求约 500 Token
- 短期上下文：最近 10 条消息
- 长期事实：关键词匹配，约注入 3 条事实
- 第二大脑：通过 `retrieveRelevant()` 注入相关用户记忆（约 900 字符）
- 默认每日限额：1,000,000 Token

## 第二大脑

Mercury 的第二大脑是一个自主、持久的用户模型，从对话中学习。它不是原始聊天记录，也不是文档转储。它存储紧凑的结构化记忆，认为这些可能有助于未来的对话。

### 它如何学习（后台、无感）

每轮非平凡对话：
1. Mercury 正常回复用户。
2. 之后后台调用 `extractMemory()` 提取 0-3 条带类型的记忆候选（preference、goal、project 等），使用独立 LLM 调用（约 800 Token）。
3. 每条候选经过 `UserMemoryStore.remember()` 处理，该函数：
   - 如果重叠度 >= 74% 则与现有记忆合并（增强证据）
   - 自动解决冲突（更高置信度胜出，相同置信度 → 更新者胜出）
   - 自动分层：identity/preference → durable，goal/project → active
   - 3+ 次强化后自动晋升：active → durable
   - 存储低置信度弱记忆 — 它们自然衰减
4. 每次心跳时，Mercury 进行整合（重新合成 profile/active 摘要，生成反思记忆）并修剪（清除陈旧记忆，强化已晋升者）。

用户永远不会看到或等待这个过程。Agent 循环中不涉及工具调用。

### 它不存储什么

- 问候语、寒暄、客套话
- 低信号的一次性细节（低于 0.55 置信度下限）
- 推测性的助手猜测

### `/memory` 命令

```
/memory        → 打开方向键菜单 (CLI) 或发送概览 (Telegram)

菜单：
  Overview          — 记忆总数、按类型细分、学习状态
  Recent            — 最近 10 条记忆（类型 + 摘要 + 置信度）
  Search            — 全文本搜索所有记忆
  Pause Learning    — 切换：停止/恢复存储新记忆
  Clear All         — 确认后清除所有记忆
  Back
```

### 用户控制

第二大脑在学习和管理上是自主的。用户的唯一控制是：
- **暂停/恢复**学习（用于敏感对话）
- **清除全部**记忆（重新开始）
- **观察**通过概览、最近和搜索

无审核队列、无手动固定、无手动冲突解决、无手动编辑。

## 渠道

### CLI
- 基于 Readline，带内联权限提示
- `mercury start` 或直接 `mercury`

### Telegram
- grammY 框架 + @grammyjs/stream 流式处理
- 处理中显示 Typing 指示器
- 通过心跳主动发送消息
- `.env` 或 `mercury.yaml` 中的 `TELEGRAM_BOT_TOKEN`

## Skill 系统

Mercury 支持 Agent Skills 规范。Skill 是模块化的可安装指令集，无需代码更改即可扩展 Mercury 的能力。

### Skill 格式

每个 Skill 是一个位于 `~/.mercury/skills/` 下的目录，包含 `SKILL.md`：

```
~/.mercury/skills/
├── daily-digest/
│   └── SKILL.md       # 必需：YAML 前置元数据 + markdown 指令
├── code-review/
│   ├── SKILL.md
│   ├── scripts/       # 可选：可执行脚本
│   └── references/    # 可选：参考文档
└── _template/
    └── SKILL.md       # 新 Skill 的种子模板
```

### SKILL.md 结构

```markdown
---
name: daily-digest
description: 发送每日活动摘要
version: 0.1.0
allowed-tools:
  - read_file
  - list_dir
  - run_command
---

# Daily Digest

当此 Skill 被调用时，Mercury 遵循的指令...
```

### 渐进式披露

- **启动时**：仅加载 Skill 名称 + 描述（Token 高效）
- **调用时**：按需通过 `use_skill` 工具加载完整 Skill 指令
- 这样系统提示保持精简，同时 Skill 可用

### Skill 工具

- `install_skill`：从 markdown 内容或 URL 安装
- `list_skills`：显示所有已安装的 Skill
- `use_skill`：加载并将 Skill 指令注入 Agent 上下文

## 调度器

Mercury 可以使用 cron 表达式调度循环任务。任务持久化到 `~/.mercury/schedules.yaml`，并在启动时恢复。

### 调度任务字段

| 字段 | 描述 |
|---|---|
| `id` | 唯一任务标识符 |
| `cron` | 标准 5 字段 cron 表达式 |
| `description` | 人类可读描述 |
| `prompt` | 任务触发时发送给 Agent 的文本提示 |
| `skill_name` | 可选：任务触发时调用的 Skill |
| `createdAt` | ISO 时间戳 |

### 任务如何执行

当调度任务触发时：
1. 如果设置了 `skill_name`，Mercury 通过 `use_skill` 调用该 Skill
2. 如果设置了 `prompt`，Mercury 将其作为内部（非渠道）消息处理
3. 内部消息不会产生可见的渠道响应 — 它们在 Agent 循环中静默运行

### 调度工具

- `schedule_task`：创建带 prompt 或 skill_name 的 Cron 任务
- `list_scheduled_tasks`：显示所有调度任务
- `cancel_scheduled_task`：移除调度任务

## 子 Agent

Mercury 支持子 Agent — 作为异步协程在同一 Node.js 进程中运行的独立工作进程。子 Agent 允许 Mercury 并发处理多个任务而不阻塞主 Agent。

### 为什么用子 Agent？

- **非阻塞**：主 Agent 在子 Agent 工作时保持对新消息的可用性
- **资源感知**：最大并发数根据 CPU 核心数和可用 RAM 自动检测
- **协调**：文件锁防止 Agent 间冲突写入
- **可控**：`/agents`、`/halt`、`/stop`、`/reset` 命令供用户完全控制
- **非阻塞**：子 Agent 在后台运行 — 主 Agent 保持对新消息的响应
- **可见**：进度通知（`🔄 Agent a1: Using: read_file`）和完成消息（`✅ Agent a1 completed (8.2s)`）发送到用户渠道
- **快速命令**：斜杠命令如 `/agents`、`/halt`、`/spotify`、`/code` 即使在主 Agent 繁忙时也立即处理

### 架构

```
用户消息 → 主 Agent → 决定：
  ├─ 快速响应 → 直接处理并回复
  └─ 重型任务 → delegate_task 工具 → 生成子 Agent（非阻塞）
       → 主 Agent 回复："🤖 Agent a1 正在处理..."
       → 主 Agent 保持对下一条消息的可用性
       → 子 Agent 进度："🔄 Agent a1: Using: read_file, edit_file"
       → 子 Agent 完成："✅ Agent a1 completed (8.2s): result..."
       → 用户可随时输入 /agents 检查状态
```

### 组件概述

| 组件 | 文件 | 用途 |
|---|---|---|
| SubAgent | `src/core/sub-agent.ts` | 工作器：带中止、文件锁、进度的隔离 Agent 循环 |
| SubAgentSupervisor | `src/core/supervisor.ts` | 编排器：生成/停止/队列、资源管理 |
| FileLockManager | `src/core/file-lock.ts` | 读写锁：多读者、排他写者、自动释放 |
| TaskBoard | `src/core/task-board.ts` | 共享状态：任务状态、进度、持久化到磁盘 |
| ResourceManager | `src/core/resource-manager.ts` | 系统检测：CPU 核心数、RAM、最大并发公式 |

### 资源限制

默认最大并发子 Agent = `clamp(1, cpus - 1, floor(availableRAM_GB / 2))`

通过 `/agents set max <n>` 或 `SUBAGENTS_MAX_CONCURRENT` 环境变量覆盖。

### 生命周期

```
unborn → birthing → onboarding → idle ⇄ thinking → responding → idle
                                                  ↓
                                          idle → delegating → idle
                                          idle → sleeping → awakening → idle
```

`delegating` 状态涵盖主 Agent 将任务交给子 Agent 时。

### 子 Agent 工具

| 工具 | 描述 |
|---|---|
| `delegate_task` | 将任务委托给子 Agent 工作器 |
| `list_agents` | 列出活跃子 Agent 及其状态 |
| `stop_agent` | 停止子 Agent（或全部） |

### 用户命令

| 命令 | 描述 |
|---|---|
| `/agents` | 列出所有子 Agent（状态、任务、进度） |
| `/agents stop <id>` | 停止特定子 Agent |
| `/agents stop all` | 停止所有子 Agent |
| `/agents pause <id>` | 在当前步骤后暂停子 Agent |
| `/agents resume <id>` | 恢复暂停的子 Agent |
| `/agents config` | 显示资源分配 |
| `/agents set max <n>` | 覆盖最大并发 Agent 数 |
| `/halt` | 紧急停止所有 Agent + 清除队列 |
| `/stop` | 停止所有 Agent + 清除队列 + 释放锁 + 清除任务板 |
| `/reset` | 完全重置：停止所有 + 清除上下文（需要确认） |

### 编程模式

Mercury 有内置编程模式（通过 `/code plan` 激活），针对 IDE 级编码任务进行优化。它在两种状态下运行：

**计划模式**（`/code plan`）：Mercury 探索代码库、分析问题、通过 `ask_user` 呈现多种方案，并勾勒逐步实现计划 — 不写代码。

**执行模式**（`/code execute`）：Mercury 逐步实现批准的计划，在更改后运行构建/测试，在检查点提交，并将独立子任务委托给子 Agent。

| 命令 | 描述 |
|---|---|
| `/code` | 显示当前编程模式状态 |
| `/code plan` | 切换到计划模式（分析、呈现选项、不编码） |
| `/code execute` | 切换到执行模式（逐步实现计划） |
| `/code off` | 退出编程模式 |
| `/code toggle` | 循环：off → plan → execute → off |

`ask_user` 工具使 Mercury 能够在 CLI 中呈现选项（方向键菜单）和 Telegram 中呈现选项（内联键盘）。

### 文件锁语义

- **读锁**：多个子 Agent 可以同时读取同一文件
- **写锁**：排他性 — 一次只有一个 Agent 可以写入文件
- **自动释放**：当子 Agent 终止时锁释放（完成、失败或停止）
- **死锁检测**：监督器检测 Agent 之间的循环等待条件

### 任务板持久化

所有子 Agent 任务状态持久化到 `~/.mercury/memory/task-board.json`，在进程重启后存活。

### 配置

```yaml
subagents:
  enabled: true        # 启用/禁用子 Agent 系统
  maxConcurrent: 0      # 0 = 从 CPU/RAM 自动检测，>0 = 手动覆盖
  mode: auto            # auto = 自动检测，manual = 使用 maxConcurrent 值
```

环境变量覆盖：`SUBAGENTS_ENABLED`、`SUBAGENTS_MAX_CONCURRENT`、`SUBAGENTS_MODE`

## Spotify 集成

Mercury 可以通过 Spotify Web API 远程控制用户的 Spotify 播放。音乐播放在用户自己的设备上（手机、网页、桌面、TV、音箱）— 不在本地。

### 设置

1. 在 https://developer.spotify.com/dashboard 创建 Spotify 应用
2. 将重定向 URI 设置为 `http://127.0.0.1:8888/callback`
3. 在 `.env` 中设置 `SPOTIFY_CLIENT_ID` 和 `SPOTIFY_CLIENT_SECRET`
4. 在 Mercury 中运行 `/spotify auth` — 这会打开浏览器进行 OAuth 授权
5. 令牌保存在 `~/.mercury/mercury.yaml` 中并自动刷新

### 设备选择

Spotify 的设备 API 列出了用户登录的所有活跃设备。Mercury 将播放/暂停/跳过命令发送到用户选择的设备 — 它从不本地播放音频。

### DJ Skill

`spotify` Skill（`/skills/spotify/SKILL.md`）激活 DJ 模式：
- 根据心情/流派/活动搜索 Spotify
- 通过 `ask_user` 呈现选项（CLI 方向键，Telegram 内联按钮）
- 管理播放、队列、喜欢和播放列表
- 根据用户口味创建策划播放列表

### 播放器 UI

**CLI**：`/spotify player` 打开交互式方向键菜单：
```
  ▶  播放 / 恢复
  ⏸  暂停
  ⏭  下一曲
  ⏮  上一曲
  🔀  切换随机播放
  🔁  循环模式
  🎵  正在播放
  📱  设备
  🔍  搜索并播放
  🔊  设置音量
  📋  加入队列
  ❤️  喜欢当前曲目
  ✕  退出播放器
```

**Telegram**：播放控制作为内联键盘按钮。

### 命令

| 命令 | 描述 |
|---|---|
| `/spotify` | 显示连接状态 |
| `/spotify auth` | 开始 OAuth 流程（打开浏览器） |
| `/spotify player` | 交互式播放器（仅 CLI） |
| `/spotify devices` | 列出活跃 Spotify 设备 |
| `/spotify device <id>` | 设置活跃设备 |
| `/spotify now` | 显示当前播放曲目 |

### 配置

```yaml
spotify:
  enabled: true
  clientId: ...
  clientSecret: ...
  redirectUri: http://127.0.0.1:8888/callback
  accessToken: ...
  refreshToken: ...
  expiresAt: ...
  scopes: [...]
  deviceId: ...
```

环境变量覆盖：`SPOTIFY_CLIENT_ID`、`SPOTIFY_CLIENT_SECRET`、`SPOTIFY_REDIRECT_URI`