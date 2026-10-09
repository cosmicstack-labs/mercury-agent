import { generateText, stepCountIs } from 'ai';
import type { ChannelMessage } from '../types/channel.js';
import type { SubAgentConfig, SubAgentResult, SubAgentStatus } from '../types/agent.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Identity } from '../soul/identity.js';
import type { ShortTermMemory, LongTermMemory, EpisodicMemory } from '../memory/store.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { MercuryConfig } from '../utils/config.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { FileLockManager } from './file-lock.js';
import type { TaskBoard } from './task-board.js';
import type { SaverMode } from './saver-mode.js';
import type { SubAgentSupervisor } from './supervisor.js';
import { createDelegateTaskTool, createListAgentsTool, createStopAgentTool } from '../capabilities/subagents/index.js';
import { getHeapStatistics } from 'node:v8';
import { memoryGovernorThresholds, memoryGovernorVerdict, CONVERSATION_TOOL_BUDGET_CHARS, TOOL_RESULT_KEEP_RECENT, summarizeToolResult } from './memory-governor.js';
import { classifyStreamCompletion } from './stream-completion.js';
import { resolveChildTools, childMayUse, filterToolsByAllowlist } from '../utils/tool-filter.js';
import { deriveChildContext, type PermissionContext } from '../capabilities/permission-context.js';
import { logger } from '../utils/logger.js';

export type ProgressCallback = (agentId: string, progress: string) => void;
export type CompletionCallback = (result: SubAgentResult) => void;
export type CommentCheckCallback = (agentId: string) => { id: string; author: string; content: string; timestamp: number }[];
export type PostCommentCallback = (agentId: string, content: string) => void;

export class SubAgent {
  readonly config: SubAgentConfig;
  private status: SubAgentStatus = 'pending';
  private abortController: AbortController;
  private startTime: number = 0;
  private result: SubAgentResult | null = null;
  private filesModified: string[] = [];

  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;

  private agentConfig: MercuryConfig;
  private providers: ProviderRegistry;
  private identity: Identity;
  private shortTerm: ShortTermMemory;
  private longTerm: LongTermMemory;
  private episodic: EpisodicMemory;
  private userMemory: UserMemoryStore | null;
  private capabilities: CapabilityRegistry;
  private tokenBudget: TokenBudget;
  private fileLockManager: FileLockManager;
  private taskBoard: TaskBoard;
  private saverMode?: SaverMode;
  private supervisor?: SubAgentSupervisor;

  private onProgress?: ProgressCallback;
  private onComplete?: CompletionCallback;
  private onCheckComments?: CommentCheckCallback;
  private onPostComment?: PostCommentCallback;
  private lastSeenCommentTimestamp: number = 0;

  constructor(
    config: SubAgentConfig,
    dependencies: {
      agentConfig: MercuryConfig;
      providers: ProviderRegistry;
      identity: Identity;
      shortTerm: ShortTermMemory;
      longTerm: LongTermMemory;
      episodic: EpisodicMemory;
      userMemory: UserMemoryStore | null;
      capabilities: CapabilityRegistry;
      tokenBudget: TokenBudget;
      fileLockManager: FileLockManager;
      taskBoard: TaskBoard;
      saverMode?: SaverMode;
      /** Needed only to hand out lineage-scoped orchestration tools. */
      supervisor?: SubAgentSupervisor;
    },
  ) {
    this.config = config;
    this.abortController = new AbortController();

    this.agentConfig = dependencies.agentConfig;
    this.providers = dependencies.providers;
    this.identity = dependencies.identity;
    this.shortTerm = dependencies.shortTerm;
    this.longTerm = dependencies.longTerm;
    this.episodic = dependencies.episodic;
    this.userMemory = dependencies.userMemory;
    this.capabilities = dependencies.capabilities;
    this.tokenBudget = dependencies.tokenBudget;
    this.fileLockManager = dependencies.fileLockManager;
    this.taskBoard = dependencies.taskBoard;
    this.saverMode = dependencies.saverMode;
    this.supervisor = dependencies.supervisor;
  }

  getStatus(): SubAgentStatus {
    return this.status;
  }

  abort(): void {
    this.abortController.abort();
    logger.info({ agentId: this.config.id }, 'Sub-agent abort signal sent');
  }

  isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  setProgressCallback(cb: ProgressCallback): void {
    this.onProgress = cb;
  }

  setCompletionCallback(cb: CompletionCallback): void {
    this.onComplete = cb;
  }

  setCommentCheckCallback(cb: CommentCheckCallback): void {
    this.onCheckComments = cb;
  }

  setPostCommentCallback(cb: PostCommentCallback): void {
    this.onPostComment = cb;
  }

  private permissionContext?: PermissionContext;

  /**
   * This agent's frozen permission context: the one the supervisor derived
   * at spawn time, or (when constructed directly) one derived now from the
   * current context. Child ⊆ parent; see permission-context.ts.
   */
  getPermissionContext(): PermissionContext | undefined {
    if (this.permissionContext) return this.permissionContext;
    if (this.config.permissionContext) {
      this.permissionContext = this.config.permissionContext;
    } else {
      const permissions = this.capabilities.permissions as any;
      if (typeof permissions?.currentContext !== 'function') return undefined;
      this.permissionContext = deriveChildContext(permissions.currentContext(), {
        channelType: this.config.sourceChannelType || 'internal',
        channelId: this.config.sourceChannelId || 'internal',
        allowedTools: this.config.allowedTools,
      });
    }
    return this.permissionContext;
  }

  /**
   * Run the task under this agent's own permission context. Every tool it
   * invokes — through any depth of the AI SDK's promise chain — resolves
   * permissions against that context via AsyncLocalStorage, so a concurrent
   * change to the main agent's context (an internal turn's allow-all) never
   * reaches it (#75/#99 residual).
   */
  async run(): Promise<SubAgentResult> {
    const ctx = this.getPermissionContext();
    const permissions = this.capabilities.permissions as any;
    if (ctx && typeof permissions?.withContext === 'function') {
      return permissions.withContext(ctx, () => this.runInContext());
    }
    return this.runInContext();
  }

  private async runInContext(): Promise<SubAgentResult> {
    this.status = 'running';
    this.startTime = Date.now();

    this.taskBoard.update(this.config.id, {
      status: 'running',
      startedAt: this.startTime,
      progress: 'Starting task...',
    });

    logger.info({ agentId: this.config.id, task: this.config.task.slice(0, 80) }, 'Sub-agent starting');

    try {
      const systemPrompt = this.buildSystemPrompt();
      const messages: any[] = [];

      // Conversation budget: compacts old tool results once retained tool
      // output exceeds the budget. A sub-agent analyzing a whole project
      // must not hold every file read verbatim for the entire run.
      const enforceConversationBudget = () => {
        const toolIdx: number[] = [];
        let total = 0;
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          if (m.role !== 'tool' || typeof m.content !== 'string') continue;
          toolIdx.push(i);
          total += m.content.length;
        }
        if (total <= CONVERSATION_TOOL_BUDGET_CHARS) return;
        const cutoff = toolIdx.slice(0, Math.max(0, toolIdx.length - TOOL_RESULT_KEEP_RECENT));
        for (const idx of cutoff) {
          messages[idx] = { ...messages[idx], content: summarizeToolResult(messages[idx].content) };
        }
        logger.info({ agentId: this.config.id, compacted: cutoff.length }, 'Sub-agent conversation budget enforced');
      };

      const governorThresholds = memoryGovernorThresholds({
        heapSizeLimit: getHeapStatistics().heap_size_limit,
        baselineHeapUsed: process.memoryUsage().heapUsed,
        reservedHeapBytes: 384 * 1024 * 1024,
      });

      messages.push({
        role: 'user',
        content: this.config.task,
      });

      this.taskBoard.update(this.config.id, { progress: 'Processing...' });

      const originalCwd = this.capabilities.getCwd();
      if (this.config.workingDirectory) {
        this.capabilities.setCwd(this.config.workingDirectory);
      }

      // Channel routing comes from this agent's permission context (set in
      // run()); the shared registry's main-agent channel is left alone.

      try {
        const provider = this.providers.getDefault();
        const baseMaxSteps = this.config.maxSteps || 25;
        const maxSteps = this.saverMode?.isActive() ? this.saverMode.adjustMaxSteps(baseMaxSteps) : baseMaxSteps;
        let stepsRemaining = maxSteps;

        logger.info({ agentId: this.config.id, provider: provider.name, maxSteps }, 'Sub-agent generating response');

        if (this.onProgress) {
          this.onProgress(this.config.id, 'Calling LLM provider...');
        }

        // Track last result for final output
        let lastResult: any = null;

        // Execution loop: run generateText, then check for new comments.
        // If new comments found, inject them as user messages and continue.
        while (stepsRemaining > 0 && !this.abortController.signal.aborted) {
          // Step-level memory checkpoint before each provider round-trip.
          const verdict = memoryGovernorVerdict(process.memoryUsage().heapUsed, governorThresholds);
          if (verdict === 'exit') {
            logger.error({ agentId: this.config.id }, 'Sub-agent: heap beyond exit threshold — exiting to preserve process');
            process.exit(0);
          }
          if (verdict === 'abort') {
            this.abortController.abort(new Error('Sub-agent stopped: task memory safety limit reached'));
            break;
          }
          enforceConversationBudget();
          const result = await generateText({
            model: provider.getModelInstance(),
            system: systemPrompt,
            messages,
            tools: this.resolveTools(),
            stopWhen: stepCountIs(stepsRemaining),
            abortSignal: this.abortController.signal,
            // Stop the SDK retaining raw HTTP bodies in every step's result
            // (same O(N²) heap growth as the main agent loop).
            experimental_include: { requestBody: false, responseBody: false },
            onStepFinish: async ({ toolCalls, toolResults, usage }) => {
              if (this.abortController.signal.aborted) return;
              stepsRemaining--;

              // Mid-loop memory checkpoint: abort generation if the heap
              // crosses the emergency ceiling (the sub-agent runs on the
              // shared process, so its blowup kills the whole app).
              const midVerdict = memoryGovernorVerdict(process.memoryUsage().heapUsed, governorThresholds);
              if (midVerdict === 'exit') {
                logger.error({ agentId: this.config.id }, 'Sub-agent: heap beyond exit threshold mid-step — exiting');
                process.exit(0);
              }
              if (midVerdict === 'abort') {
                this.abortController.abort(new Error('Sub-agent stopped: task memory safety limit reached'));
                return;
              }

              // Accumulate live token usage
              if (usage) {
                this.totalInputTokens += usage.inputTokens ?? 0;
                this.totalOutputTokens += usage.outputTokens ?? 0;
                const liveTotal = this.totalInputTokens + this.totalOutputTokens;
                this.taskBoard.update(this.config.id, {
                  tokenUsage: { input: this.totalInputTokens, output: this.totalOutputTokens, total: liveTotal },
                });
              }

              if (toolCalls && toolResults && toolCalls.length > 0) {
                const names = toolCalls.map((tc: any) => tc.toolName).join(', ');
                logger.info({ agentId: this.config.id, tools: names }, 'Sub-agent tool step');

                for (let i = 0; i < toolCalls.length; i++) {
                  const tc = toolCalls[i];
                  const toolName = tc.toolName as string;

                  if (['write_file', 'edit_file', 'create_file', 'delete_file'].includes(toolName)) {
                    const filePath = (tc.input as any)?.path || (tc.input as any)?.filePath;
                    if (filePath) {
                      const acquired = this.fileLockManager.acquire(filePath, this.config.id, 'write');
                      if (!acquired) {
                        this.filesModified.push(filePath);
                      }
                    }
                  }

                  if (['read_file', 'list_dir'].includes(toolName)) {
                    const filePath = (tc.input as any)?.path || (tc.input as any)?.filePath;
                    if (filePath) {
                      this.fileLockManager.acquire(filePath, this.config.id, 'read');
                    }
                  }
                }

                if (this.onProgress) {
                  this.onProgress(this.config.id, `Using: ${names}`);
                }
              }
            },
          });

          lastResult = result;

          // Stream integrity: generateText can resolve with finishReason
          // 'other' when the provider dropped the connection mid-generation
          // (no terminal chunk). Treat as a failure so the sub-agent reports
          // honestly instead of completing with truncated/empty output.
          const completion = classifyStreamCompletion({
            finishReason: (result as any)?.finishReason,
            hasText: Boolean(result?.text),
            hasToolCalls: true,
          });
          if (completion === 'interrupted') {
            logger.warn({ agentId: this.config.id, finishReason: (result as any)?.finishReason }, 'Sub-agent generation ended without a provider finish signal');
            throw new Error('Generation was interrupted before completion (no finish signal from provider)');
          }

          // Append the assistant response to the conversation history
          if (result.text) {
            messages.push({ role: 'assistant', content: result.text });

            // If this was a response to user comments, post the reply as an agent comment
            if (this.onPostComment && this.lastSeenCommentTimestamp > 0) {
              const replyText = result.text.trim();
              if (replyText.length > 0 && replyText !== '(no text response)') {
                this.onPostComment(this.config.id, replyText.length > 500 ? replyText.slice(0, 500) + '...' : replyText);
              }
            }
          }

          // Check for new user comments on this card
          if (this.onCheckComments && !this.abortController.signal.aborted && stepsRemaining > 0) {
            const newComments = this.onCheckComments(this.config.id)
              .filter(c => c.timestamp > this.lastSeenCommentTimestamp);

            if (newComments.length > 0) {
              this.lastSeenCommentTimestamp = Math.max(...newComments.map(c => c.timestamp));
              const commentText = newComments
                .map(c => `[${c.author}]: ${c.content}`)
                .join('\n');

              logger.info({ agentId: this.config.id, count: newComments.length }, 'Sub-agent received new comments');

              messages.push({
                role: 'user',
                content: `The admin has left new comments on your task card. Please read, reflect, and adjust your approach if needed. Then reply with your thoughts and continue working.\n\n${commentText}`,
              });

              if (this.onProgress) {
                this.onProgress(this.config.id, `Reviewing ${newComments.length} new comment${newComments.length > 1 ? 's' : ''}...`);
              }

              // Continue the loop — generateText will be called again with the comments
              continue;
            }
          }

          // No new comments — we're done
          break;
        }

        const result = lastResult;

        if (this.abortController.signal.aborted) {
          this.status = 'halted';
          const duration = Date.now() - this.startTime;
          this.result = {
            agentId: this.config.id,
            task: this.config.task,
            status: 'halted',
            output: 'Task was halted by user.',
            filesModified: this.filesModified,
            duration,
            tokenUsage: {
              input: result?.usage?.inputTokens ?? this.totalInputTokens,
              output: result?.usage?.outputTokens ?? this.totalOutputTokens,
            },
          };

          this.taskBoard.update(this.config.id, {
            status: 'halted',
            completedAt: Date.now(),
            result: this.result.output,
          });

          return this.result;
        }

        // Completion contract: the loop exited because the step budget ran
        // out while the last round still had tool calls pending. That is a
        // pause, never a completion — the supervisor resumes with a fresh
        // budget; reporting 'completed' here shipped half-done work behind a
        // success status.
        if (stepsRemaining <= 0 && (result as any)?.finishReason === 'tool-calls') {
          this.status = 'paused';
          const duration = Date.now() - this.startTime;
          this.result = {
            agentId: this.config.id,
            task: this.config.task,
            status: 'paused',
            output: 'Step budget reached before the task completed — work so far is preserved; resuming with a fresh budget.',
            filesModified: this.filesModified,
            duration,
            tokenUsage: {
              input: this.totalInputTokens,
              output: this.totalOutputTokens,
            },
          };
          this.taskBoard.update(this.config.id, {
            status: 'paused',
            completedAt: Date.now(),
            progress: 'Step budget reached — resuming',
          });
          logger.info({ agentId: this.config.id, duration }, 'Sub-agent paused at step budget (completion contract)');
          return this.result;
        }

        const finalText = (result?.text || '').trim() || '(no text response)';

        this.tokenBudget.recordUsage({
          provider: provider.name,
          model: provider.getModel(),
          inputTokens: this.totalInputTokens,
          outputTokens: this.totalOutputTokens,
          totalTokens: this.totalInputTokens + this.totalOutputTokens,
          channelType: 'internal',
        });

        this.episodic.record({
          type: 'message',
          summary: `Sub-agent ${this.config.id}: ${this.config.task.slice(0, 60)} → ${finalText.slice(0, 60)}`,
          channelType: 'internal',
        });

        this.status = 'completed';
        const duration = Date.now() - this.startTime;
        this.result = {
          agentId: this.config.id,
          task: this.config.task,
          status: 'completed',
          output: finalText,
          filesModified: this.filesModified,
          duration,
          tokenUsage: {
            input: this.totalInputTokens,
            output: this.totalOutputTokens,
          },
        };

        this.taskBoard.update(this.config.id, {
          status: 'completed',
          completedAt: Date.now(),
          result: finalText,
          progress: 'Task completed',
        });

        logger.info({ agentId: this.config.id, duration }, 'Sub-agent completed');

        return this.result;
      } finally {
        if (this.config.workingDirectory) {
          this.capabilities.setCwd(originalCwd);
        }
        this.capabilities.permissions.clearElevation();
        this.fileLockManager.releaseAll(this.config.id);
      }
    } catch (err: any) {
      if (this.abortController.signal.aborted) {
        this.status = 'halted';
        const duration = Date.now() - this.startTime;
        this.result = {
          agentId: this.config.id,
          task: this.config.task,
          status: 'halted',
          output: 'Task was halted by user.',
          filesModified: this.filesModified,
          duration,
          tokenUsage: { input: 0, output: 0 },
        };

        this.taskBoard.update(this.config.id, {
          status: 'halted',
          completedAt: Date.now(),
          result: this.result.output,
        });

        return this.result;
      }

      this.status = 'failed';
      const duration = Date.now() - this.startTime;
      this.result = {
        agentId: this.config.id,
        task: this.config.task,
        status: 'failed',
        output: `Task failed: ${err.message}`,
        error: err.message,
        filesModified: this.filesModified,
        duration,
        tokenUsage: { input: 0, output: 0 },
      };

      this.taskBoard.update(this.config.id, {
        status: 'failed',
        completedAt: Date.now(),
        result: this.result.output,
        error: err.message,
      });

      logger.error({ agentId: this.config.id, err }, 'Sub-agent failed');

      return this.result;
    }
  }

  /**
   * Tools handed to the model. `allowedTools` is a real runtime restriction:
   * when set, the child never sees tools outside the list. The orchestration
   * tools (delegate_task, list_agents, stop_agent) are stripped unless the
   * parent granted them by name, and a granted one is re-bound to THIS
   * agent's id so the supervisor confines it to this agent's descendants —
   * the shared registry instance carries the main agent's authority (#74).
   */
  private resolveTools() {
    let tools = resolveChildTools(this.capabilities.getTools(), this.config.allowedTools);
    // The context's allowlist is the parent's ∩ this agent's: a grandchild
    // can never be granted a tool its parent did not have.
    const ctxTools = this.getPermissionContext()?.allowedTools;
    if (ctxTools) tools = filterToolsByAllowlist(tools, ctxTools);
    const ctxAllows = (name: string) => !ctxTools || ctxTools.includes(name);
    if (this.supervisor) {
      const scoped = { callerId: this.config.id };
      if (childMayUse('delegate_task', this.config.allowedTools) && ctxAllows('delegate_task')) {
        tools.delegate_task = createDelegateTaskTool(this.supervisor, this.capabilities, scoped);
      }
      if (childMayUse('list_agents', this.config.allowedTools) && ctxAllows('list_agents')) {
        tools.list_agents = createListAgentsTool(this.supervisor, scoped);
      }
      if (childMayUse('stop_agent', this.config.allowedTools) && ctxAllows('stop_agent')) {
        tools.stop_agent = createStopAgentTool(this.supervisor, scoped);
      }
    }
    return tools;
  }

  /** Names of the tools this agent actually receives. */
  getToolNames(): string[] {
    return Object.keys(this.resolveTools());
  }

  private buildSystemPrompt(): string {
    let prompt = this.identity.getSystemPrompt(this.agentConfig.identity);

    prompt += `\n\nYou are a sub-agent (ID: ${this.config.id}) working independently on a specific task.`;
    prompt += `\nTask: ${this.config.task}`;
    prompt += `\n${this.describePermissions()}`;
    prompt += `\nFocus only on completing this task efficiently.`;
    if (this.config.workingDirectory) {
      prompt += `\nWorking directory: ${this.config.workingDirectory}`;
    }
    if (this.config.allowedTools && this.config.allowedTools.length > 0) {
      prompt += `\nAllowed tools: ${this.config.allowedTools.join(', ')}`;
    }
    prompt += `\nWhen done, provide a clear summary of what you accomplished.`;

    const budgetStatus = this.tokenBudget.getStatusText();
    prompt += '\n\n' + budgetStatus;
    if (this.tokenBudget.getUsagePercentage() > 70) {
      prompt += '\nBe concise to conserve tokens.';
    }
    const saverSuffix = this.saverMode?.getSystemPromptSuffix() ?? '';
    if (saverSuffix) {
      prompt += saverSuffix;
    }

    prompt += `\n\nEnvironment:\n- Platform: ${process.platform}\n- Working directory: ${this.capabilities.getCwd()}`;

    prompt += `\n\nAvailable tools: ${this.getToolNames().join(', ')}`;

    return prompt;
  }

  /**
   * An accurate statement of what this agent may do: it runs under the same
   * permission state as the agent that delegated it — the same approved
   * scopes, the same shell approval prompt — never with elevated rights.
   */
  private describePermissions(): string {
    const permissions = this.capabilities.permissions;
    const readable: string[] = [];
    const writable: string[] = [];
    for (const scope of [...permissions.getManifest().capabilities.filesystem.scopes, ...(this.getPermissionContext()?.scopes ?? [])]) {
      if (scope.write) writable.push(scope.path);
      else if (scope.read) readable.push(scope.path);
    }
    const parts: string[] = [];
    parts.push('You run with the same permissions as the agent that delegated you, not more.');
    const ctx = this.getPermissionContext();
    if (ctx ? ctx.autoApprove : permissions.isAutoApproveAll()) {
      parts.push('This session is in Allow All mode, so approved-scope actions run without prompts.');
    } else {
      parts.push('File writes and non-read-only shell commands go to the user for approval (reads inside approved scopes do not); a denial is final — do not retry it or work around it.');
    }
    if (writable.length > 0) parts.push(`Writable scopes: ${writable.join(', ')}.`);
    if (readable.length > 0) parts.push(`Read-only scopes: ${readable.join(', ')}.`);
    parts.push('Use approve_scope to request a path outside these scopes.');
    if (this.config.allowedTools?.some(t => ['delegate_task', 'list_agents', 'stop_agent'].includes(t))) {
      parts.push('Your delegate_task/list_agents/stop_agent only reach agents you delegated yourself.');
    }
    return parts.join(' ');
  }
}
