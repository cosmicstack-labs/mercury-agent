# 更新日志

## 1.1.5 — 更顺畅的引导流程

### 修复：引导流程不再阻塞没有 Ollama 的用户

引导流程存在一个关键 UX 问题：如果用户没有本地运行的 Ollama 或没有现成的 API key，他们会陷入无限循环，无法跳过。这是一个重大体验改进。

**主要变化：**

1. **Ollama 本地现可跳过** — 如果 Ollama 没有运行，你可以直接跳过或手动输入模型名称。不会再有无限的重复循环。

2. **所有 Provider 设置允许跳过** — 每个 API key 提示现在在 Provider API 不可达时都提供手动模型名称输入选项和跳过选项。错误消息从红色（失败）改为黄色（警告）以减少挫败感。

3. **移除"无 Provider"陷阱** — 之前如果你无法配置任何 Provider，就会陷入无限循环。现在你可以输入"skip"保存配置稍后通过 `mercury doctor` 回来，并显示关于 DeepSeek 免费 API 的提示。

4. **清除 Ollama 本地默认模型** — 默认值是 `gpt-oss:20b`（非标准模型）。现在默认为空，首选模型列表使用常见名称如 `llama3.2`、`mistral`、`phi3` 等。

5. **更清晰的首次运行说明** — LLM Provider 步骤现在显示"你可以按 Enter 跳过任何 Provider"并注明 DeepSeek 提供免费 key。

### 变更摘要

| 文件 | 变更 |
|------|--------|
| `src/index.ts` | `promptOllamaLocalModelSelection` — 允许跳过 base URL，获取失败时手动输入模型 |
| `src/index.ts` | `promptApiKeyWithModelSelection` — API 获取失败时手动输入模型，提供跳过选项 |
| `src/index.ts` | `configure()` — 无 Provider 配置时提供"skip"选项，显示免费 key 提示 |
| `src/utils/config.ts` | Ollama 本地默认模型从 `gpt-oss:20b` 改为空字符串 |
| `src/utils/provider-models.ts` | Ollama 本地首选模型更新为常见名称 |

## 1.1.4 — OpenAI 兼容 Provider & Provider 可见性

### 新增：OpenAI 兼容 Provider

一个专用于**自托管、第三方或任何 OpenAI 兼容 API** 的新 Provider — 无论是在你的系统上、自托管还是云服务。社区需要一种连接任意 OpenAI 兼容端点的方式，而不绑定到特定供应商。

**设置向导流程：**
1. 输入服务器 base URL（必需）— 例如 `http://localhost:8000/v1` 或 `https://my-llm.example.com/v1`
2. 可选输入 API key（按 Enter 跳过 — 本地/自托管服务器通常不需要）
3. Mercury 尝试从 `/models` 端点获取模型列表
4. 如果成功 — 显示交互式模型选择器并提供输入自定义名称的选项
5. 如果获取失败 — 提示手动输入模型名称
6. 你可以随时在保存前输入自定义模型名称

**关键设计点：**
- API key 是**可选的** — 本地和自托管服务器通常无需身份验证即可运行
- 使用 Chat Completions API（`/chat/completions`），而非 Responses API（`/responses`）
- `isProviderConfigured` 需要 `baseUrl + model` 但不需要 `apiKey`
- 不过滤模型名称 — 接受服务器返回的所有模型 ID
- 可设置为默认 Provider
- 环境变量：`OPENAI_COMPAT_API_KEY`、`OPENAI_COMPAT_BASE_URL`、`OPENAI_COMPAT_MODEL`、`OPENAI_COMPAT_ENABLED`

### 新增：会话启动时的 Provider & 模型可见性

活动 Provider 和模型现在在会话启动时突出显示 — 一个**洋红色徽章**（`⚡ Provider · Model`）让人立即清楚正在使用哪个 LLM。完整 Provider 列表显示在下方，带 `← default` 标记。

之前：
```
  Providers: DeepSeek, OpenAI
  Models: DeepSeek: deepseek-chat | OpenAI: gpt-4o-mini
```

之后：
```
 ⚡ DeepSeek · deepseek-chat
  Providers: DeepSeek: deepseek-chat ← default  ·  OpenAI: gpt-4o-mini
```

### 修复：`fetchOpenAICompatModels` 可选 API key 处理

内部 `fetchOpenAICompatModels` 函数现在仅在配置了 API key 时才发送 `Authorization: Bearer` header — 之前即使 key 为空也会发送 header，导致不需要 auth header 的本地服务器出现认证错误。

`OpenAICompatProvider` 现在也通过传递 `'no-key'` 作为 `createOpenAI()` 的回退值来优雅处理空 API key，防止在未认证服务器上崩溃。

### 变更摘要

| 文件 | 变更 |
|------|--------|
| `src/utils/config.ts` | 添加 `openaiCompat` 到 `ProviderName`、配置接口、默认值、`isProviderConfigured()` |
| `src/providers/registry.ts` | 路由 `openaiCompat` → `OpenAICompatProvider`，`useChatApi: true` |
| `src/providers/openai-compat.ts` | 使用 `'no-key'` 回退处理空 API key 以配合 `createOpenAI()` |
| `src/utils/provider-models.ts` | `OPENAI_COMPAT_PREFERRED_MODELS`、模型获取中的可选 auth header、`openaiCompat` 不过滤模型、路由 |
| `src/index.ts` | "OpenAI Compilations" 在 `PROVIDER_OPTIONS` 中，`promptOpenAICompatSetup()` 使用获取→回退流程，会话启动时显示洋红色默认 Provider 徽章 |
| `.env.example` | 添加 `OPENAI_COMPAT_*` 环境变量 |
| `src/utils/provider-models.test.ts` | 添加 2 个 `openaiCompat` 模型目录测试 |

## 1.1.3 — 修复 Ollama Cloud Provider

### 问题描述

Ollama Cloud 完全损坏 — 每个请求都返回 `404 Not Found`。两个独立 bug 导致 `ollamaCloud` 无法工作：

### Bug 1：错误的 SDK — 本地 Ollama API 而非 OpenAI 兼容 Chat Completions

`ollamaCloud` 通过 `OllamaProvider` 路由，该 Provider 使用 `ollama-ai-provider` 包。这个包专为**本地** Ollama 服务器设计，目标是 `/api/chat` 和 `/api/tags` 端点。Ollama Cloud 暴露的是**OpenAI 兼容** API，位于 `/v1/chat/completions` 和 `/v1/models` — 一个完全不同的线格式。

- **模型列表**调用 `${baseUrl}/tags` → `https://ollama.com/api/tags` → 404
- **聊天补全**调用 `${baseUrl}/chat` → `https://ollama.com/api/chat` → 404

**修复**：`ollamaCloud` 现在通过 `OpenAICompatProvider` 路由（使用 `createOpenAI()` 来自 `@ai-sdk/openai`），匹配所有其他 OpenAI 兼容云提供商（MiMo、Grok）使用的模式。

### Bug 2：错误的默认 base URL

默认 `OLLAMA_CLOUD_BASE_URL` 设置为 `https://ollama.com/api` — 本地 Ollama 服务器路径。Ollama Cloud OpenAI 兼容 API 的正确 base URL 是 `https://ollama.com/v1`。

**修复**：更新默认值并添加配置迁移（`migrateLegacyOllamaCloudBaseUrl`），在启动时自动将现有 `mercury.yaml` 文件从 `/api` 升级到 `/v1`。

### Bug 3：Responses API 而非 Chat Completions API

修复 Bug 1 后，`OpenAICompatProvider` 使用 `createOpenAI()()` 默认到 OpenAI 的 **Responses API**（`/responses`）。Ollama Cloud 只支持 **Chat Completions API**（`/chat/completions`），导致 `https://ollama.com/api/responses` → 404。

**修复**：向 `OpenAICompatProvider` 添加 `useChatApi` 选项。启用时（对 `ollamaCloud`），它调用 `client.chat(model)` 而非 `client(model)`，目标是 `/chat/completions`。

### Bug 4：ollamaCloud 没有 baseUrl 验证

`isProviderConfigured()` 和 `OllamaProvider.isAvailable()` 只检查 `ollamaCloud` 的 `apiKey.length > 0` — 缺失或空的 `baseUrl` 不会被捕获，导致在请求时出现神秘故障。

**修复**：在 `isProviderConfigured()` 和 `isAvailable()` 中添加显式 `ollamaCloud` 分支，验证 `apiKey` 和 `baseUrl`。

### 变更摘要

| 文件 | 变更 |
|------|--------|
| `src/providers/registry.ts` | 路由 `ollamaCloud` → `OpenAICompatProvider`，`useChatApi: true` |
| `src/providers/openai-compat.ts` | 添加 `useChatApi` 选项使用 Chat Completions API |
| `src/utils/config.ts` | 默认 base URL `https://ollama.com/api` → `https://ollama.com/v1`；添加 `ollamaCloud` 到 `isProviderConfigured()`；添加 `migrateLegacyOllamaCloudBaseUrl()` |
| `src/utils/provider-models.ts` | 新的 `fetchOllamaCloudModels()` 使用 `/models`（OpenAI 兼容）；重命名 `fetchOllamaModels` → `fetchOllamaLocalModels`（仅本地 `/tags`）；单独路由 `ollamaCloud` |
| `src/providers/ollama.ts` | `isAvailable()` 也验证非本地 Provider 的 `baseUrl` |
| `.env.example` | `OLLAMA_CLOUD_BASE_URL` 默认值更新为 `https://ollama.com/v1` |
| `src/utils/provider-models.test.ts` | 添加 2 个 `ollamaCloud` 模型目录测试 |

## 1.1.2 — MiMo Provider & 预算加固

## 1.0.0 — 第二大脑

这是一个**主要版本**，因为它引入了第二大脑 — 一个由 SQLite 全文搜索支持的持久化结构化记忆系统 — 以及 Mercury 存储数据和渲染输出的方式的基本变更。

### 为什么是 1.0.0？

Mercury 通过 0.x 版本快速开发。第二大脑功能代表了基本能力转变：Mercury 现在可以**跨对话记忆**，自动提取、整合和召回关于你的事实。结合全 `~/.mercury/` 数据架构和实时 CLI 流式输出，这标记着一个值得主要版本的稳定、生产就绪的基础。

### 第二大脑 🧠

- **10 种记忆类型** — identity、preference、goal、project、habit、decision、constraint、relationship、episode、reflection
- **自动提取** — 每轮对话后提取 0 到 3 条事实，带置信度、重要性和持久性分数
- **相关召回** — 每次消息前在 900 字符预算内注入最匹配的 5 条记忆
- **自动整合** — 每 60 分钟合成个人资料摘要、活跃状态摘要，并从检测到的模式生成反思记忆
- **冲突解决** — 对立记忆按置信度和时间新旧解决；否定检测处理"喜欢 X"与"不喜欢 X"
- **活跃 → 持久晋升** — 记忆被强化 3+ 次后自动从短期 `active` 作用域晋升到长期 `durable` 作用域
- **自动修剪** — 活跃作用域记忆 21 天后过期；推断记忆会衰减；低置信度持久记忆 120 天后 dismissal
- **SQLite + FTS5** — 全文搜索即时召回，所有数据本地存储在 `~/.mercury/memory/second-brain/second-brain.db`
- **用户控制** — `/memory` 用于概览、搜索、暂停、恢复和清除，CLI 和 Telegram 都支持

### CLI 流式输出恢复

- **实时文本流** — 原始响应 Token 流式传输到终端，然后使用正确的 markdown 格式重新渲染完整响应（青色标题带 `■` 标记，黄色代码块， dim 项目符号， dim 边框的块引用）
- **光标保存/恢复** — 使用 `\x1b7`/`\x1b8` ANSI 序列而非脆弱的行计数，消除单行答案的重复响应 bug
- **流式传输期间的工具反馈** — 工具调用在流式传输期间内联显示，并被跟踪以进行准确的输出替换

### 数据架构：全在 `~/.mercury/`

- **之前**：记忆（短期、长期、情景）相对于 CWD 存储在 `./memory/`，在随机项目目录中创建文件
- **之后**：所有状态现在位于 `~/.mercury/` — 配置、soul、记忆、权限、skills、调度、Token 跟踪、守护进程状态
- **`getMemoryDir()`** 辅助函数返回 `~/.mercury/memory/` — 不再有 `memory.dir` 配置字段
- **自动迁移** — 首次运行时，Mercury 检测并移动任何遗留 `./memory/` 目录到 `~/.mercury/memory/`，然后删除旧目录
- **移除的配置字段**：`memory.dir`、`memory.secondBrain.dbPath` — 现在从 `getMercuryHome()` 自动计算

### 权限模式

- **问我** — 文件写入前确认，需要批准的 Shell 命令和作用域更改（CLI 和 Telegram 的默认模式）
- **全部允许** — 自动批准本次会话的所有内容（作用域、命令、循环继续）。重启后重置。
- CLI：启动时方向键菜单。Telegram：首条消息内联键盘，`/permissions` 更改。

### 逐步工具反馈

- **编号步骤** — 每个工具调用获得步骤编号（`1. read_file foo.ts`）
- **旋转器** — 工具执行时显示带已用时间的动画旋转器
- **结果摘要** — 每个步骤后显示简洁结果（例如 `42 行，3 个匹配`）

### 其他变更

- **改进的 markdown 渲染器** — 青色标题带 `■` 标记，黄色内联代码， dim 删除线，蓝色下划线链接带 dim URL，边框块引用，边框表格
- **HTML 实体解码** — 修复 marked HTML 输出的双重编码
- **Telegram 组织访问** — 管理员和成员，具有批准/拒绝/晋升/降级流程
- **引导期间的模型选择** — 验证 API key 后，Mercury 获取可用模型并让你选择
- **Telegram 可编辑状态消息** — 流式更新使用 `editMessageText` 进行实时响应编辑
- **调度任务通知** — Mercury 在调度任务运行时通知原始渠道
- **调度任务的完整临时作用域** — 任务在全部允许模式下运行，作用域自动批准

### 破坏性变更

- 记忆数据路径从 `./memory/` 更改为 `~/.mercury/memory/` — 自动迁移处理
- 配置字段 `memory.dir` 移除 — 无需操作，值被忽略
- 配置字段 `memory.secondBrain.dbPath` 移除 — 路径现在自动计算

### 完整更新日志

**0.5.4** — 修复流式对齐，移除 Agent 名称重复，更干净的块格式
**0.5.3** — 添加 mercury upgrade 命令，ENOTEMPTY 修复
**0.5.2** — 修复 readline 提示处理、流式重新渲染、交互式循环检测、HTML 实体解码
**0.5.1** — Bug 修复
**0.5.0** — Telegram 组织访问、模型选择、更新文档
**0.4.0** — 社交媒体 skills、GitHub 伴侣
**0.3.0** — 权限系统、skill 系统、调度器
**0.2.0** — Telegram 流式传输、文件上传、守护进程模式
**0.1.0** — 初始版本