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
import { logger } from '../utils/logger.js';

export type ProgressCallback = (agentId: string, progress: string) => void;
export type CompletionCallback = (result: SubAgentResult) => void;

export class SubAgent {
  readonly config: SubAgentConfig;
  private status: SubAgentStatus = 'pending';
  private abortController: AbortController;
  private startTime: number = 0;
  private result: SubAgentResult | null = null;
  private filesModified: string[] = [];

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

  private onProgress?: ProgressCallback;
  private onComplete?: CompletionCallback;

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

  async run(): Promise<SubAgentResult> {
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

      messages.push({
        role: 'user',
        content: this.config.task,
      });

      this.taskBoard.update(this.config.id, { progress: 'Processing...' });

      const originalCwd = this.capabilities.getCwd();
      if (this.config.workingDirectory) {
        this.capabilities.setCwd(this.config.workingDirectory);
      }

      this.capabilities.permissions.setAutoApproveAll(true);
      this.capabilities.permissions.addTempScope('/', true, true);

      this.capabilities.setChannelContext(
        this.config.sourceChannelId || 'internal',
        this.config.sourceChannelType || 'internal',
      );

      try {
        const provider = this.providers.getDefault();
        const maxSteps = this.config.maxSteps || 25;

        logger.info({ agentId: this.config.id, provider: provider.name, maxSteps }, 'Sub-agent generating response');

        if (this.onProgress) {
          this.onProgress(this.config.id, 'Calling LLM provider...');
        }

        const result = await generateText({
          model: provider.getModelInstance(),
          system: systemPrompt,
          messages,
          tools: this.capabilities.getTools(),
          stopWhen: stepCountIs(maxSteps),
          abortSignal: this.abortController.signal,
          onStepFinish: async ({ toolCalls, toolResults }) => {
            if (this.abortController.signal.aborted) return;

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
              input: result.usage?.inputTokens ?? 0,
              output: result.usage?.outputTokens ?? 0,
            },
          };

          this.taskBoard.update(this.config.id, {
            status: 'halted',
            completedAt: Date.now(),
            result: this.result.output,
          });

          return this.result;
        }

        const finalText = (result.text || '').trim() || '(no text response)';

        this.tokenBudget.recordUsage({
          provider: provider.name,
          model: provider.getModel(),
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
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
            input: result.usage?.inputTokens ?? 0,
            output: result.usage?.outputTokens ?? 0,
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
        this.capabilities.permissions.setAutoApproveAll(false);
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

  private buildSystemPrompt(): string {
    let prompt = this.identity.getSystemPrompt(this.agentConfig.identity);

    prompt += `\n\nYou are a sub-agent (ID: ${this.config.id}) working independently on a specific task.`;
    prompt += `\nTask: ${this.config.task}`;
    prompt += `\nYou have full permissions for this task. Focus only on completing this task efficiently.`;
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

    prompt += `\n\nEnvironment:\n- Platform: ${process.platform}\n- Working directory: ${this.capabilities.getCwd()}`;

    const toolNames = this.capabilities.getToolNames();
    const toolsList = this.config.allowedTools
      ? toolNames.filter(t => this.config.allowedTools!.includes(t))
      : toolNames;
    prompt += `\n\nAvailable tools: ${toolsList.join(', ')}`;

    return prompt;
  }
}