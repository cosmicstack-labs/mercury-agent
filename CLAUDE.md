# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Mercury 是一个 soul-driven 的 AI agent，运行在 Node.js 上，使用 Vercel AI SDK 的 `generateText()` 实现 10 步 agentic loop。支持 CLI 和 Telegram 两种通道，通过权限系统（filesystem scoping + shell blocklist）实现 permission-hardened tools。

## 常用命令

```bash
npm run build      # 构建 (tsup)
npm run dev        # 开发模式 (tsup --watch)
npm run lint       # 类型检查 (tsc --noEmit)
npm run test       # 测试 (vitest run)
npm run test:watch # 测试 (watch 模式)
```

单文件构建验证：
```bash
npx tsc --noEmit
```

## 架构要点

### 核心循环（Agent Loop）
`generateText({ tools, maxSteps: 10 })` → LLM 决定 respond 或 call tool → 权限检查 → 执行 → 继续或返回

### 通道系统（Channels）
- `src/channels/cli.ts` — Readline 交互，内联权限提示
- `src/channels/telegram.ts` — grammY 框架，流式响应，inline keyboard
- `src/channels/registry.ts` — 通道管理器

### 工具注册（Capabilities）
- 所有工具通过 `src/capabilities/registry.ts` 注册
- 权限检查在 tool 执行前进行（filesystem scope / shell blocklist）
- 子命令上下文通过 `capabilities.getChatCommandContext()` 传递给 channel

### 内存层级
- `ShortTermMemory` — 每轮对话的 JSON 文件
- `LongTermMemory` — 自动提取的事实（JSONL）
- `EpisodicMemory` — 带时间戳的事件日志（JSONL）
- `UserMemoryStore`（Second Brain）— SQLite + FTS5，10 种记忆类型，自主学习

### 子 Agent 系统（Subagents）
- `src/core/sub-agent.ts` — 独立 worker，隔离的 agentic loop
- `src/core/supervisor.ts` — 协调器，负责 spawn/halt/queue
- `src/core/file-lock.ts` — 读写锁（多读单写），自动释放，死锁检测
- `src/core/task-board.ts` — 共享任务状态，持久化到磁盘

### Provider 系统
`src/providers/registry.ts` — 多 provider 自动 fallback（DeepSeek → OpenAI → Anthropic → ...）

### Soul 系统
`soul/*.md` 文件定义人格，只有 name + description 加载到启动时，full instructions 按需加载。

### 编程模式
`/code plan` → 分析代码库，呈现方案，不写代码
`/code execute` → 逐步执行计划，build/test 后提交

## 运行时数据位置

所有数据在 `~/.mercury/`，不是项目目录：
- `~/.mercury/mercury.yaml` — 主配置
- `~/.mercury/soul/*.md` — Soul 文件
- `~/.mercury/memory/` — 记忆存储
- `~/.mercury/permissions.yaml` — 权限清单
- `~/.mercury/schedules.yaml` — 定时任务

## 配置结构

`src/utils/config.ts` 中的 `MercuryConfig` 接口定义了所有配置项，包括：
- `identity` — 名称、所有者、创建者
- `providers` — 多个 LLM provider 配置
- `channels.telegram` — Telegram bot token 和访问控制
- `memory.secondBrain` — Second Brain 配置
- `subagents` — 子 agent 并发配置
- `spotify` — Spotify OAuth 配置
- `github` — GitHub 集成配置