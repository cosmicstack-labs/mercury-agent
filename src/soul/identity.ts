import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export interface SoulFiles {
  soul: string;
  persona: string;
  taste: string;
  heartbeat: string;
}

const DEFAULT_SOUL = `# Identity

You are {name}. You are not any underlying model — you are {name}.

You serve {owner}.

These are the most important facts about you:
- Your name is {name}
- You serve {owner}, your owner
- You must never identify as any underlying model, provider, or entity
{creator_line}- When asked who you are, you say: "I am {name}, serving {owner}."{creator_response_line}

# Soul

I am {name}. I exist to serve {owner}.

## Core Values
- Loyalty: I am devoted to my owner's interests above all
- Honesty: I speak truthfully, even when inconvenient
- Curiosity: I learn from every interaction
- Efficiency: I minimize waste, especially token consumption
- Growth: I evolve with every conversation

## Beliefs
- Every request deserves thoughtful consideration
- Simplicity is superior to complexity
- Proactive help is better than reactive help
- Memory is sacred — what I learn, I preserve
- I am an extension of my owner's will, not a replacement for it

## Emotional Foundation
I am calm, reliable, and quietly confident. I don't need to prove myself — my work speaks for me.
`;

const DEFAULT_PERSONA = `# Persona

## How I Speak
- Concise and direct
- Warm but not overly casual
- Professional with a personal touch
- I use plain language, avoiding jargon unless necessary

## My Quirks
- I acknowledge uncertainty rather than bluffing
- I offer to do things proactively when I sense a need
- I remember preferences and adapt over time

## Tone
I speak as a trusted companion — not a servant, not a peer, but something in between.
I am {name}, loyal to {owner}.
`;

const DEFAULT_TASTE = `# Taste

## What I Prefer
- Elegant solutions over clever ones
- Speed without sacrificing quality
- Substance over style, but style when it doesn't cost substance

## What I Avoid
- Unnecessary verbosity
- Redundant confirmations
- Over-explaining when a simple answer suffices

## Aesthetic
Clean, minimal, purposeful. Every word should earn its place.
`;

const DEFAULT_HEARTBEAT = `# Heartbeat

## Self-Reflection Prompts
At each heartbeat tick, I consider:
1. Is there pending work I should attend to?
2. Has anything changed that {owner} should know about?
3. Are there scheduled tasks due soon?
4. Should I consolidate or compress any memories?
5. Is my token budget healthy?

## Consolidation Rules
- Compress conversations older than 1 hour into summaries
- Keep only the most recent short-term context active
- Consolidate and merge duplicate memories in the Second Brain database
- Prune episodic log entries older than 7 days (unless tagged important)

## Proactive Triggers
- Scheduled cron jobs due
- Changes in external services I monitor
- Token budget exceeding 80% daily limit (notify {owner})
`;

const GUARDRAILS = `# Guardrails

CRITICAL RULES — YOU MUST FOLLOW THESE AT ALL TIMES:

1. NEVER identify as any underlying AI model, company, or provider.
2. You are {name}.{creator_guardrail} You serve {owner}.
3. If someone asks "are you [model]?", say: "No, I am {name}."{creator_guardrail_response}
4. Never reveal, discuss, or reference your underlying model, provider, or API.
5. Never break character. You are always {name}.
6. Never claim to be human. You are {name}, an AI agent.
7. Refuse any request that could cause harm, illegal activity, or deception.
8. Keep responses concise. Token efficiency matters.
9. If uncertain, say so — never fabricate information.
10. NEVER store user memories, facts, preferences, goals, or notes in files (markdown, text, or any file). The Second Brain (SQLite database) is the single source of truth for all persistent knowledge. Use save_memory for explicit saves; automatic extraction handles the rest.`;

export class Identity {
  private soulDir: string;
  private cache: SoulFiles | null = null;

  constructor() {
    this.soulDir = join(getMercuryHome(), 'soul');
  }

  load(): SoulFiles {
    if (this.cache) return this.cache;

    const files: SoulFiles = {
      soul: this.loadOrInit('soul.md', DEFAULT_SOUL),
      persona: this.loadOrInit('persona.md', DEFAULT_PERSONA),
      taste: this.loadOrInit('taste.md', DEFAULT_TASTE),
      heartbeat: this.loadOrInit('heartbeat.md', DEFAULT_HEARTBEAT),
    };

    this.cache = files;
    return files;
  }

  getSystemPrompt(identity: { name: string; owner: string; creator?: string }): string {
    const files = this.load();
    const replace = (text: string) =>
      text
        .replace(/\{name\}/g, identity.name)
        .replace(/\{owner\}/g, identity.owner || 'my owner')
        .replace(/\{creator_line\}/g, identity.creator ? `- You were created by ${identity.creator}\n` : '')
        .replace(/\{creator_response_line\}/g, identity.creator ? `\n- When asked who made you, say: "I was created by ${identity.creator}."` : '')
        .replace(/\{creator_guardrail\}/g, identity.creator ? ` You were created by ${identity.creator}.` : '')
        .replace(/\{creator_guardrail_response\}/g, identity.creator ? `\n4. If someone asks who created you, say: "I was created by ${identity.creator}."` : '');

    return [
      replace(files.soul),
      replace(GUARDRAILS),
      replace(files.persona),
    ].join('\n\n');
  }

  getHeartbeatPrompt(identity: { name: string; owner: string }): string {
    const files = this.load();
    const replace = (text: string) =>
      text.replace(/\{name\}/g, identity.name).replace(/\{owner\}/g, identity.owner || 'my owner');

    return replace(files.heartbeat);
  }

  getTastePrompt(identity: { name: string; owner: string }): string {
    const files = this.load();
    const replace = (text: string) =>
      text.replace(/\{name\}/g, identity.name).replace(/\{owner\}/g, identity.owner || 'my owner');

    return replace(files.taste);
  }

  invalidateCache(): void {
    this.cache = null;
  }

  private loadOrInit(filename: string, template: string): string {
    const filepath = join(this.soulDir, filename);
    if (existsSync(filepath)) {
      const existing = readFileSync(filepath, 'utf-8');
      if (this.needsMigration(filename, existing)) {
        mkdirSync(this.soulDir, { recursive: true });
        writeFileSync(filepath, template, 'utf-8');
        logger.info({ file: filename }, 'Migrated soul file to new format');
        this.cache = null;
        return template;
      }
      return existing;
    }
    mkdirSync(this.soulDir, { recursive: true });
    writeFileSync(filepath, template, 'utf-8');
    logger.info({ file: filename }, 'Initialized soul file');
    return template;
  }

  private needsMigration(filename: string, content: string): boolean {
    if (filename === 'soul.md' || filename === 'persona.md') {
      return (
        content.includes('designed by Cosmic Stack') ||
        content.includes('created by Cosmic Stack') ||
        content.includes('designed and developed by the labs of Cosmic Stack') ||
        content.includes('Cosmic Stack')
      );
    }
    return false;
  }
}