# Mercury — 架构决策

> 架构决策记录。新的决策将随时追加。

[English](./DECISIONS.md)

## ADR-001: TypeScript + Node.js

- **背景**: 需要一个 24/7 无头代理运行时，同时考虑未来集成 GUI、移动端和聊天渠道。
- **决策**: 使用 TypeScript + Node.js。
- **结果**: 最佳的 AI SDK 生态系统（Vercel AI SDK）、Ink 用于 TUI、grammY 用于 Telegram，最易扩展至所有未来渠道。

## ADR-002: Ink 用于 TUI

- **背景**: CLI 需要生动有趣 — 动画、进度条、打字机效果。
- **决策**: Ink + React 用于终端 UI。
- **结果**: 比 Commander 学习曲线更陡，但体验卓越。初期 CLI 使用 readline；Ink 在第二阶段引入。

## ADR-003: 平面文件存储

- **背景**: 内存需要简单、可检查、对 Git 友好。
- **决策**: 长期/情景记忆用 JSONL，短期记忆用 JSON。
- **结果**: 易于调试，无需数据库依赖。后续可能需要 SQLite 实现语义搜索。

## ADR-004: grammY 用于 Telegram

- **背景**: 需要 Telegram 集成，支持流式输出和打字状态。
- **决策**: grammY + @grammyjs/stream + @grammyjs/auto-retry。
- **结果**: 最好的 TypeScript Telegram 框架。内置流式支持，社区活跃。

## ADR-005: Vercel AI SDK 用于 LLM

- **背景**: 需要支持多个提供商（OpenAI、Anthropic、DeepSeek）并实现流式输出。
- **决策**: 使用 Vercel AI SDK（`ai` 包）配合各提供商适配器。
- **结果**: 统一 API、内置流式输出、工具调用。切换提供商只需改一行代码。

## ADR-006: Soul 分离为独立 Markdown 文件

- **背景**: 代理人格需要可编辑、可版本化、令牌高效。
- **决策**: 四个独立 Markdown 文件：soul.md、persona.md、taste.md、heartbeat.md。每次请求只注入 soul + persona；taste + heartbeat 选择性注入。
- **结果**: 身份基线约 350 tokens。主人可以在不修改代码的情况下编辑人格。

## ADR-007: Agent Skills 规范

- **背景**: Skills 需要模块化、可运行时安装、令牌高效。
- **决策**: 采用 Agent Skills 规范（agentskills.io）。Skills 使用带有 YAML frontmatter 的 `SKILL.md` + markdown 说明。存储在 `~/.mercury/skills/`。渐进披露：启动时只加载 name + description；调用时才加载完整说明。
- **结果**: Skills 是人类可读的 markdown，无需代码。令牌预算保持低位。通过粘贴内容或 URL 安装。

## ADR-008: 支持 YAML 持久化的调度器

- **背景**: Mercury 需要设置提醒、执行周期性任务、按计划触发 skills。
- **决策**: 将 `schedule_task`、`list_scheduled_tasks`、`cancel_scheduled_task` 暴露为 AI 可调用工具。将计划任务持久化到 `~/.mercury/schedules.yaml`。启动时恢复。任务作为内部（非渠道）消息通过代理循环触发。
- **结果**: Mercury 可以自主调度工作。任务在重启后存活。内部执行使计划任务对渠道不可见，除非代理显式发送输出。

## ADR-009: 自定义混合Daemon化方案

- **背景**: Mercury 24/7 运行但目前仅前台模式。关闭终端会终止进程，导致 Telegram、定时任务和心跳中断。非技术用户不应需要手动安装 PM2/forever/systemd 脚本。
- **决策**: 在 Mercury 中原生构建自定义混合 daemon 管理器。无外部依赖。分三层：
  1. **后台启动** — `child_process.spawn({detached: true})` + PID 文件 + 日志重定向。通过 `mercury start -d` 激活。
  2. **看门狗** — 内置指数退避崩溃恢复（基础 1s，1.25 倍，最多 10 次重启/60s）。仅在 daemon 模式激活。
  3. **平台服务生成器** — `mercury service install` 检测操作系统并生成相应配置：Linux 上为 `systemd --user` unit，macOS 上为 `~/Library/LaunchAgents` plist，Windows 上为启动快捷方式。Mac/Linux 无需 root。
- **备选方案考虑**:
  - `node-windows/mac/linux` 三件套 — 部分已停止维护，Mac 上需要 sudo，node-linux 已停止开发
  - PM2 作为依赖 — 15MB，50+ 依赖，AGPL-3.0 许可证
  - PM2 作为用户安装 — 要求非技术用户学习单独工具
  - `forever` — 已被官方弃用
  - 仅原生后台模式 — 无崩溃恢复，无启动自启
- **结果**: 核心 daemon 化零外部依赖。启动服务为用户级（Mac/Linux 无需 sudo）。Windows 获取后台模式 + 文档化的 PM2 路径。前台模式不变 — daemon 模式为可选。在 daemon 模式下，CLI 变为仅日志；Telegram（或其他远程渠道）为交互界面。

## ADR-010: 第二大脑 — SQLite 支持的自主结构化记忆

- **背景**: Mercury 需要一个持久的用户模型，从对话中学习。此前的 LongTermMemory（平面 JSONL）太简单 — 仅关键字搜索，无结构，无合并，无冲突处理，无层级。第二大脑已有部分实现（用于 SQLite 的 second-brain-db.ts，用于 JSON 的 user-memory.ts），但两者都是断开的死代码。
- **决策**: 使用 SQLite（better-sqlite3）作为存储后端，结合 UserMemoryStore 业务逻辑层构建统一第二大脑。关键原则：
  - **自主**: 无审核队列，无用户审批。记忆通过置信度自动存储、合并、去冲突。弱记忆以低分保留，自然衰减。
  - **自动冲突解决**: 检测到极性冲突时（如"偏好 X"vs"不偏好 X"），高置信度记忆静默胜出。置信度相等时 → 较新的胜出。
  - **自动分层**: 目标和项目等记忆类型初始为 `active`（有时限）；身份和偏好初始为 `durable`。强化 3+ 次的记忆从 active 晋升为 durable。
  - **过期清理**: 21 天未见的 active 推断记忆被清除。120 天无强化的 durable 推断记忆置信度衰减；低于 0.3 时被清除。
  - **对用户不可见**: 记忆提取在响应发送后作为后台任务执行。代理循环中无工具调用，无状态消息。用户无需等待。
  - **10 种记忆类型**: identity、preference、goal、project、habit、decision、constraint、relationship、episode、reflection。
  - **FTS5 全文搜索** 用于 `/memory search` 命令。
- **备选方案考虑**:
  - 仅 JSON（UserMemoryStore 原样）— 逻辑好但无搜索，扩展性差
  - 仅 SQLite（SecondBrainDB 原样）— 存储好但无合并/冲突/反思逻辑
  - 向量嵌入 — 对当前规模过于奢侈，增加重量级依赖
- **结果**: WAL 模式的 SQLite 为提示注入提供快速读取（微秒级）。FTS5 支持快速搜索。业务逻辑（合并、冲突、反思、分层、过期）继承自 UserMemoryStore。一个原生依赖（better-sqlite3）。用户的唯一控制：观察（概览、最近、搜索）、暂停/恢复学习、清除全部。
