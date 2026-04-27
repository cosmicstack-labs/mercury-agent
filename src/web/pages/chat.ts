import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderChat(c: Context): string {
  const body = `
    <div x-data="chatScreen()" x-init="init()" class="chat-container">
      <div class="chat-layout">
        <aside class="chat-threads">
          <div class="chat-threads-head">
            <button class="btn btn-sm btn-primary btn-block" @click="createThread()">+ New Thread</button>
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
            <button class="btn btn-sm btn-outline btn-block" @click="exportThread()" :disabled="!activeThreadId">Export Thread</button>
            <button class="btn btn-sm btn-danger btn-block" @click="deleteThread()" :disabled="!activeThreadId">Delete Thread</button>
          </div>
        </aside>

      <section class="chat-main">
      <div class="chat-header">
        <div class="chat-header-info">
          <button class="chat-back-btn" @click="goHome()" title="Back to dashboard">←</button>
          <h1 x-text="activeThreadTitle()">Chat</h1>
          <span class="chat-provider" x-show="provider" x-text="'Using ' + provider + ' / ' + model"></span>
          <span class="chat-perm-badge" :class="settings.bypassPermissions ? 'chat-perm-auto' : 'chat-perm-ask'" @click="togglePermissions()" :title="settings.bypassPermissions ? 'Auto-approve: tool calls run without asking' : 'Ask me: tool calls require your approval'">
            <span x-show="settings.bypassPermissions">🔓 Auto</span>
            <span x-show="!settings.bypassPermissions">🔒 Ask</span>
          </span>
        </div>
        <div class="chat-header-actions">
          <button class="btn btn-sm btn-outline" @click="clearChat()">Clear</button>
        </div>
      </div>

      <div class="chat-messages" x-ref="messagesContainer" @scroll="onScroll()">
        <div class="chat-empty" x-show="activeMessages().length === 0 && !waiting">
          <div class="chat-empty-icon">☿</div>
          <p>Start a conversation with Mercury</p>
          <p class="chat-empty-hint">Messages are processed by the agent and streamed back in real time</p>
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

              <template x-for="(step, si) in (msg.steps || [])" :key="si">
                <div class="chat-step" :class="{ 'chat-step-running': step.running, 'chat-step-done': step.done }">
                  <div class="chat-step-header" @click="step.open = !step.open">
                    <span class="chat-step-status" x-show="step.running"><span class="step-spinner"></span></span>
                    <span class="chat-step-status" x-show="!step.running && step.done">✓</span>
                    <span class="chat-step-status" x-show="!step.running && step.done === false && step.error">✗</span>
                    <span class="chat-step-tool" x-text="'Step ' + (si + 1) + ': ' + step.tool"></span>
                    <span class="chat-step-summary-inline" x-show="!step.open && step.summary" x-text="step.summary"></span>
                    <span class="chat-step-toggle" x-text="step.open ? '−' : '+'"></span>
                  </div>
                  <div class="chat-step-body" x-show="step.open" x-html="step.label"></div>
                </div>
              </template>

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

              <div class="chat-msg-elapsed" x-show="msg.role === 'assistant' && msg.elapsedMs" x-text="'Response time: ' + (msg.elapsedMs / 1000).toFixed(1) + 's'"></div>
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

      <button class="chat-scroll-bottom" x-show="!isAtBottom" @click="scrollToBottom()">↓</button>

      <div class="chat-input-area">
        <textarea
          x-ref="chatInput"
          class="form-input chat-input"
          placeholder="Type a message..."
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
          <span x-show="!waiting">Send</span>
          <span x-show="waiting" class="thinking-dots">Sending</span>
        </button>
      </div>
      </section>
      </div>
    </div>
  `;

  return renderLayout(c, 'Chat', body);
}