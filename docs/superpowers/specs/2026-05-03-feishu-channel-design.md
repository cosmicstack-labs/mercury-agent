# Feishu 渠道接入设计草案（MVP）

**日期**：2026-05-03  
**分支**：`feature/feishu-channel`

## 1. 背景

Mercury 目前已经有 CLI 和 Telegram 两个渠道，且通道抽象、消息路由、能力注册都已成型。现有实现说明：

- `Channel` 接口已经统一了 `start/stop/send/sendFile/stream/typing/onMessage`。
- `ChannelRegistry` 负责按配置注册通道并分发入站消息。
- `Agent` 主循环按 `channelId` 将结果发回源渠道。

这意味着 Feishu 不需要重写 Agent，只需要补一个新的通道实现，并把配置与路由接上。

## 2. 目标

本阶段只做 **Feishu 私聊文本 + 基础访问控制**。

### 成功标准

- 能在 Feishu 私聊中接收用户消息。
- 已批准用户的消息能进入 Mercury 主循环。
- Mercury 的回复能回到原 Feishu 会话。
- 未批准用户只能进入 pending，不会直接和 Agent 交互。
- Feishu 通道配置缺失时，不能影响 CLI / Telegram 启动。

## 3. 非目标

本阶段明确不做：

- 群聊 @ 处理
- 卡片交互
- 文件上传/发送
- 流式逐字编辑
- 多租户支持
- 复杂 RBAC

## 4. 方案对比

### 方案 A：长连接事件订阅

由 Feishu 官方长连接/事件订阅方式接收消息，Mercury 常驻进程直接消费事件。

**优点**
- 更适合常驻 Agent。
- 事件入口与进程生命周期一致。
- 不需要额外公网 Webhook 入口的复杂部署。

**缺点**
- 依赖 Feishu 事件订阅能力与 SDK 接入方式。
- 需要处理事件幂等与会话映射。

### 方案 B：Webhook 事件回调

Feishu 将事件 POST 到 Mercury 暴露的 HTTP endpoint。

**优点**
- 实现概念清晰。
- 如果已有公网入口，接入路径直接。

**缺点**
- 需要验签、解密、重试、幂等处理。
- 部署条件更苛刻，对本地/自托管不友好。

### 方案 C：双模式兼容

同时支持长连接和 Webhook。

**优点**
- 覆盖最广。

**缺点**
- 首版复杂度明显上升。
- 会把 MVP 的开发和测试面拉大。

### 推荐

**推荐方案 A**。原因是 Mercury 本身就是一个 24/7 常驻 Agent，长连接和它的运行模型最一致，也最适合先验证 Feishu 渠道是否值得长期维护。

## 5. 总体设计

### 5.1 新增通道实现

新增 `src/channels/feishu.ts`，实现现有 `Channel` 接口。

MVP 需要的方法：

- `start()`：初始化 Feishu 连接和事件监听。
- `stop()`：停止监听并释放资源。
- `send()`：发送纯文本回复。
- `stream()`：先退化为一次性发送。
- `onMessage()`：把 Feishu 入站消息转换为 `ChannelMessage`。
- `isReady()`：暴露通道就绪状态。

暂不实现：

- `sendFile()`
- 复杂 `typing()`
- 卡片消息流式编辑

### 5.2 注册与路由

- 在 `src/channels/registry.ts` 中按 `channels.feishu.enabled` 和必要凭据注册 `FeishuChannel`。
- 在 `src/index.ts` 中将 `send_message` / `send_file` 的目标通道路由改为“优先回到当前消息来源渠道”。
- 保持 CLI 和 Telegram 现有行为不变。

### 5.3 配置扩展

在 `src/utils/config.ts` 扩展 `MercuryConfig.channels`：

```ts
channels: {
  telegram: { ... },
  feishu: {
    enabled: boolean;
    appId: string;
    appSecret: string;
    allowedUserIds: string[];
    admins: FeishuAccessUser[];
    members: FeishuAccessUser[];
    pending: FeishuPendingRequest[];
  }
}
```

说明：

- `allowedUserIds` 是可选白名单，作为最小 ACL。
- `admins / members / pending` 的结构只用于 Feishu，不与 Telegram 共享。
- 用户主键使用 Feishu 的稳定用户 ID，不使用昵称。

### 5.4 消息模型

Feishu 入站消息统一转换为 `ChannelMessage`，字段要求：

- `channelType = 'feishu'`
- `channelId` 使用 Feishu 会话标识
- `senderId` 使用 Feishu 用户唯一 ID
- `senderName` 作为辅助显示，不作为身份依据
- `metadata` 保存 Feishu 原始事件中的必要标识，用于幂等和定位

### 5.5 访问控制

MVP 采用与 Telegram 类似的三段式状态：

1. 新用户消息进入 pending。
2. CLI 侧审核通过后进入 members 或 admins。
3. 只有已批准用户可以进入 Agent 主循环。

首版不做 Feishu 内部审批 UI，审批动作仍由 CLI 侧完成，保持现有 Mercury 的运维路径一致。

## 6. 数据流

1. Feishu 事件到达 `FeishuChannel`。
2. 通道层先做基础校验和幂等判断。
3. 未授权用户进入 pending；已授权用户被封装为 `ChannelMessage`。
4. `ChannelRegistry` 将消息转交 `Agent`。
5. `Agent` 执行工具调用与推理。
6. `send()` 按消息来源渠道把结果发回 Feishu。

## 7. 错误处理与安全

### 7.1 错误处理

- 配置缺失：跳过 Feishu 注册，不影响其他通道。
- 外部接口失败：记录日志并降级，不让主进程崩溃。
- 重复事件：以事件 ID 做幂等，防止重复入队。
- 非私聊消息：先忽略，不扩大首版范围。
- 文本过长：先做简单分段或截断，保证可发送。

### 7.2 安全

- 用户身份只信任 Feishu 稳定 ID，不信任昵称或展示名。
- 如果后续启用 Webhook，再补验签与解密。
- 只保留最小必要的事件字段，避免把原始 payload 大量落日志。

## 8. 测试计划

### 单元/集成检查

- 通道注册：Feishu enabled 时能注册，disabled 时不注册。
- 路由：Feishu 入站消息回复仍回到 Feishu。
- 访问控制：未批准用户只会进入 pending。
- 幂等：重复事件不会导致重复处理。
- 配置回归：现有 CLI / Telegram 行为不变。

### 基线验证

- `npm run build`
- `npm run lint`
- `npm run test`

## 9. 交付边界

第一阶段交付只要求：

- Feishu 私聊能与 Mercury 互通文本。
- 基础访问控制可用。
- 不破坏现有 CLI / Telegram。

后续可在同一分支继续扩展：

- 群聊 @
- 卡片交互
- 文件发送
- 更完整的 Feishu 事件与状态管理

## 10. 结论

Feishu 渠道适合以独立通道方式接入，且第一版应该尽量收敛到 **私聊文本 + 基础访问控制**。这样可以快速验证渠道价值，同时把风险控制在可回滚范围内。
