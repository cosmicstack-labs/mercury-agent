import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderChat(c: Context): string {
  const body = `
    <div x-data="chatScreen()" x-init="init()" class="chat-container" :class="{ 'workspace-active': workspaceOpen }">
      <div class="chat-layout" :class="{ 'chat-layout-workspace': workspaceOpen }">

        <!-- Thread sidebar (left) -->
        <aside class="chat-threads" :class="{ 'chat-threads-hidden': workspaceOpen }">
          <div class="chat-threads-head">
            <button class="btn btn-primary btn-sm btn-block" @click="createThread()">+ New Thread</button>
          </div>
          <div class="chat-thread-list">
            <template x-for="t in threads" :key="t.id">
              <div class="chat-thread-item" :class="{ 'active': t.id === activeThreadId }" @click="switchThread(t.id)">
                <div class="chat-thread-title" x-text="t.title"></div>
                <div class="chat-thread-meta" x-text="formatTime(t.updatedAt)"></div>
              </div>
            </template>
          </div>
          <div class="chat-threads-foot">
            <button class="btn btn-outline btn-sm btn-block" @click="exportThread()" :disabled="!activeThreadId">Export</button>
            <button class="btn btn-danger btn-sm btn-block" @click="deleteThread()" :disabled="!activeThreadId">Delete</button>
          </div>
        </aside>

        <!-- Workspace file tree (left, when workspace is active) -->
        <aside class="ws-file-tree" x-show="workspaceOpen">
          <div class="ws-file-head">
            <span class="ws-file-title" x-text="wsRootName()">Workspace</span>
            <button class="btn btn-ghost btn-sm" @click="refreshFileTree()" title="Refresh">↻</button>
          </div>
          <div class="ws-breadcrumb" x-show="wsCurrentPath !== '.'">
            <button class="btn btn-ghost btn-xs" @click="navigateUp()">← Back</button>
            <span class="ws-path-text" x-text="wsCurrentPath"></span>
          </div>
          <div class="ws-file-list">
            <template x-for="item in wsFiles" :key="item.path">
              <div class="ws-file-item" :class="{ 'ws-file-active': wsActiveFile === item.path }"
                   @click="item.isDirectory ? navigateTo(item.path) : openFile(item.path)">
                <span class="ws-file-icon" x-text="item.isDirectory ? '📁' : '📄'"></span>
                <span class="ws-file-name" x-text="item.name"></span>
                <span class="ws-file-size" x-show="!item.isDirectory" x-text="formatFileSize(item.size)"></span>
              </div>
            </template>
            <div class="ws-empty" x-show="wsFiles.length === 0">No files</div>
          </div>
        </aside>

        <!-- Main chat area -->
        <section class="chat-main">
          <div class="chat-header">
            <div class="chat-header-info">
              <button class="chat-back-btn" @click="goHome()" title="Back to dashboard">
                <svg><use href="/vendor/icons.svg#arrow-left"/></svg>
              </button>
              <h1 x-text="activeThreadTitle()">Chat</h1>
              <span class="chat-provider" x-show="provider" x-text="provider + ' / ' + model"></span>
            </div>
            <div class="chat-header-actions">
              <button class="btn btn-ghost btn-sm" @click="toggleRightPanel()" :class="{ 'btn-active': rightPanelOpen }" title="Settings panel">
                <svg style="width:14px;height:14px"><use href="/vendor/icons.svg#settings"/></svg>
              </button>
              <button class="btn btn-ghost btn-sm" @click="toggleWorkspace()" :class="{ 'btn-active': workspaceOpen }" title="Workspace">
                <svg style="width:14px;height:14px"><use href="/vendor/icons.svg#puzzle"/></svg>
              </button>
              <button class="btn btn-ghost btn-sm" @click="clearChat()">Clear</button>
            </div>
          </div>

          <!-- Task progress bar (compact, for long-running tasks) -->
          <div class="chat-progress" x-show="waiting && totalSteps > 0">
            <div class="chat-progress-bar">
              <div class="chat-progress-fill" :style="'width:' + progressPercent() + '%'"></div>
            </div>
            <div class="chat-progress-info">
              <span class="chat-progress-step" x-text="'Step ' + totalSteps"></span>
              <span class="chat-progress-tool" x-text="currentStepTool"></span>
            </div>
          </div>

          <div class="chat-messages" x-ref="messagesContainer" @scroll="onScroll()">
            <div class="chat-empty" x-show="activeMessages().length === 0 && !waiting">
              <div class="chat-empty-icon">☿</div>
              <p>Start a conversation with Mercury</p>
              <p class="chat-empty-hint">Type a message, use slash commands like /models or /help, or open a workspace to start coding.</p>
            </div>

            <template x-for="(msg, idx) in activeMessages()" :key="msg.id">
              <div :class="msg.role === 'user' ? 'chat-msg chat-msg-user' : 'chat-msg chat-msg-assistant'">
                <div class="chat-msg-avatar" x-text="msg.role === 'user' ? 'You' : '☿'"></div>
                <div class="chat-msg-body">
                  <div class="chat-msg-meta">
                    <span class="chat-msg-agent" x-show="msg.role === 'assistant' && msg.provider" x-text="msg.provider + ' / ' + msg.model"></span>
                    <span class="chat-msg-time" x-text="formatTime(msg.timestamp)"></span>
                  </div>
                  <div class="chat-msg-content" x-show="msg.role === 'user'" x-text="msg.content"></div>
                  <div class="chat-msg-content chat-msg-markdown" x-show="msg.role === 'assistant'" x-html="msg.content ? renderMarkdown(msg.content) : ''"></div>
                  <div class="chat-msg-streaming" x-show="msg.role === 'assistant' && msg.streaming">
                    <span class="streaming-cursor"></span>
                  </div>

                  <!-- Compact step indicators -->
                  <div class="chat-steps-compact" x-show="msg.steps && msg.steps.length > 0">
                    <div class="chat-steps-summary" @click="msg._stepsOpen = !msg._stepsOpen">
                      <span class="chat-steps-count">
                        <span x-show="msg.steps.some(s => s.running)" class="step-spinner-sm"></span>
                        <span x-text="msg.steps.length + ' step' + (msg.steps.length !== 1 ? 's' : '')"></span>
                      </span>
                      <span class="chat-steps-toggle" x-text="msg._stepsOpen ? '−' : '+'"></span>
                    </div>
                    <div class="chat-steps-detail" x-show="msg._stepsOpen">
                      <template x-for="(step, si) in (msg.steps || [])" :key="si">
                        <div class="chat-step" :class="{ 'chat-step-running': step.running, 'chat-step-done': step.done }">
                          <div class="chat-step-header" @click="step.open = !step.open">
                            <span class="chat-step-status" x-show="step.running"><span class="step-spinner"></span></span>
                            <span class="chat-step-status" x-show="!step.running && step.done" style="color: var(--success);">&#10003;</span>
                            <span class="chat-step-status" x-show="!step.running && step.done === false && step.error" style="color: var(--error);">&#10007;</span>
                            <span class="chat-step-tool" x-text="step.tool"></span>
                            <span class="chat-step-summary-inline" x-show="!step.open && step.summary" x-text="step.summary"></span>
                            <span class="chat-step-toggle" x-text="step.open ? '−' : '+'"></span>
                          </div>
                          <div class="chat-step-body" x-show="step.open" x-html="step.label"></div>
                        </div>
                      </template>
                    </div>
                  </div>

                  <template x-for="(perm, pi) in (msg.permissions || [])" :key="perm.id">
                    <div class="chat-permission">
                      <div class="chat-permission-prompt" x-text="perm.prompt"></div>
                      <div class="chat-permission-actions" x-show="!perm.resolved">
                        <template x-for="opt in perm.options" :key="opt">
                          <button
                            :class="'btn btn-sm ' + (opt === 'yes' || opt === 'always' ? 'btn-primary' : (opt === 'no' || opt === 'deny' ? 'btn-danger' : 'btn-outline'))"
                            @click="resolvePermission(perm.id, opt)"
                            x-text="opt === 'yes' ? 'Allow' : (opt === 'always' ? 'Always' : (opt === 'no' ? 'Deny' : opt))"
                          ></button>
                        </template>
                      </div>
                      <div class="chat-permission-resolved" x-show="perm.resolved" x-text="perm.resolvedAction ? 'Resolved: ' + perm.resolvedAction : 'Expired'"></div>
                    </div>
                  </template>

                  <template x-if="msg.role === 'assistant' && msg.prompt">
                    <details class="chat-prompt-details">
                      <summary class="chat-prompt-summary">View prompt</summary>
                      <pre class="chat-prompt-content" x-text="msg.prompt"></pre>
                    </details>
                  </template>

                  <div class="chat-msg-elapsed" x-show="msg.role === 'assistant' && msg.elapsedMs" x-text="(msg.elapsedMs / 1000).toFixed(1) + 's'"></div>
                </div>
              </div>
            </template>

            <div class="chat-thinking" x-show="waiting && !streamingText">
              <div class="chat-msg chat-msg-assistant">
                <div class="chat-msg-avatar">☿</div>
                <div class="chat-msg-body">
                  <div class="chat-msg-content">
                    <span class="thinking-dots">Thinking</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <button class="chat-scroll-bottom" x-show="!isAtBottom" @click="scrollToBottom()">
            <svg><use href="/vendor/icons.svg#chevron-down"/></svg>
          </button>

          <div class="chat-input-area">
            <textarea
              x-ref="chatInput"
              class="chat-input"
              placeholder="Message Mercury... (/ for commands)"
              x-model="inputText"
              @keydown.enter.prevent="if (!$event.shiftKey) sendMessage()"
              @keydown.escape="inputText = ''"
              rows="1"
              autofocus
            ></textarea>
            <button
              class="btn btn-primary chat-send-btn"
              @click="sendMessage()"
              :disabled="waiting || !inputText.trim()"
            >
              <svg style="width:16px;height:16px"><use href="/vendor/icons.svg#send"/></svg>
            </button>
          </div>
        </section>

        <!-- Right settings panel -->
        <aside class="chat-right-panel" x-show="rightPanelOpen" x-transition>
          <!-- Model selector -->
          <div class="rp-section">
            <div class="rp-section-title">Model</div>
            <div class="rp-model-list">
              <template x-for="p in availableModels" :key="p.name">
                <button class="rp-model-item" :class="{ 'rp-model-active': p.isCurrent }" @click="switchModel(p.name)">
                  <span class="rp-model-name" x-text="p.name"></span>
                  <span class="rp-model-detail" x-text="p.model"></span>
                  <span class="rp-model-check" x-show="p.isCurrent">&#10003;</span>
                </button>
              </template>
              <div class="rp-empty" x-show="availableModels.length === 0">No providers configured</div>
            </div>
          </div>

          <!-- Programming mode -->
          <div class="rp-section">
            <div class="rp-section-title">Mode</div>
            <div class="rp-mode-group">
              <button class="rp-mode-btn" :class="{ 'rp-mode-active': codeState === 'off' }" @click="setCodeMode('off')">Chat</button>
              <button class="rp-mode-btn" :class="{ 'rp-mode-active': codeState === 'plan' }" @click="setCodeMode('plan')">Plan</button>
              <button class="rp-mode-btn" :class="{ 'rp-mode-active': codeState === 'execute' }" @click="setCodeMode('execute')">Execute</button>
            </div>
          </div>

          <!-- Permissions -->
          <div class="rp-section">
            <div class="rp-section-title">Permissions</div>
            <label class="rp-toggle">
              <input type="checkbox" :checked="settings.bypassPermissions" @change="togglePermissions()">
              <span>Auto-approve tool calls</span>
            </label>
          </div>

          <!-- Workspace -->
          <div class="rp-section">
            <div class="rp-section-title">Workspace</div>
            <div class="rp-workspace-path" x-show="wsRoot">
              <span class="text-mono text-xs" x-text="wsRoot" style="word-break: break-all;"></span>
            </div>
            <div class="rp-workspace-actions">
              <button class="btn btn-outline btn-sm btn-block" @click="openWorkspaceDialog()">
                <span x-text="wsRoot ? 'Change' : 'Open Workspace'"></span>
              </button>
              <button class="btn btn-ghost btn-sm btn-block" x-show="wsRoot" @click="toggleWorkspace()">
                <span x-text="workspaceOpen ? 'Close Files' : 'Show Files'"></span>
              </button>
            </div>
          </div>
        </aside>

        <!-- Workspace file preview (right side, when a file is open) -->
        <aside class="ws-file-preview" x-show="workspaceOpen && wsFileContent !== null">
          <div class="ws-preview-head">
            <span class="ws-preview-name" x-text="wsFileName"></span>
            <button class="btn btn-ghost btn-xs" @click="closeFilePreview()">×</button>
          </div>
          <pre class="ws-preview-code"><code x-text="wsFileContent"></code></pre>
        </aside>

      </div>
    </div>
  `;

  return renderLayout(c, 'Chat', body);
}
