import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderChat(c: Context): string {
  const body = `
    <div x-data="chatScreen()" x-init="init()" class="chat-container">
      <div class="chat-header">
        <div class="chat-header-info">
          <h1>Chat</h1>
          <span class="chat-provider" x-show="provider" x-text="'Using ' + provider + ' / ' + model"></span>
        </div>
        <div class="chat-header-actions">
          <button class="btn btn-sm" @click="clearChat()" x-show="messages.length > 0">Clear</button>
        </div>
      </div>

      <div class="chat-messages" x-ref="messagesContainer" @scroll="throttledScrollCheck()">
        <div class="chat-empty" x-show="messages.length === 0 && !waiting">
          <div class="chat-empty-icon">☿</div>
          <p>Start a conversation with Mercury</p>
          <p class="chat-empty-hint">Messages are processed by the agent and streamed back in real time</p>
        </div>

        <template x-for="(msg, idx) in messages" :key="msg.id">
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
                <div class="chat-step">
                  <div class="chat-step-header" @click="step.open = !step.open">
                    <span class="chat-step-tool" x-text="'Step ' + (si + 1) + ': ' + step.tool"></span>
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

      <div class="chat-input-area">
        <textarea
          x-ref="chatInput"
          class="form-input chat-input"
          placeholder="Type a message..."
          x-model="inputText"
          @keydown.enter.prevent="if (!$event.shiftKey) sendMessage()"
          @keydown.escape="inputText = ''"
          rows="1"
          :disabled="waiting"
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
    </div>
  `;

  return renderLayout(c, 'Chat', body);
}