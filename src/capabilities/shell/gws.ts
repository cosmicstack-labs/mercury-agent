import { tokenizePosix } from './argv-lane.js';

export type GwsClass = 'read' | 'write' | 'sensitive' | 'credentials';

export interface GwsCommand {
  kind: GwsClass;
  service?: string;
  target: string;
  reason: string;
}

interface Word {
  raw: string;
  value: string;
}

const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time']);
const GWS_PROGRAMS = new Set(['gws', 'gws.exe', 'gws.cmd']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const DLX_RUNNERS = new Set(['pnpm', 'yarn']);
const RUNNER_FLAGS = new Set(['-y', '--yes', '-q', '--quiet', '--silent', '--prefer-offline', '--prefer-online']);
const GWS_PACKAGE = /^@googleworkspace\/cli(?:@\S+)?$/i;
const GWS_PACKAGE_MENTION = /@googleworkspace\/cli/i;

const OPEN_SERVICES = ['drive', 'sheets', 'gmail', 'calendar', 'docs', 'slides', 'tasks', 'people', 'chat', 'classroom', 'forms', 'keep', 'meet', 'events', 'modelarmor', 'workflow', 'wf', 'script'];
const GUARDED_SERVICES = ['admin', 'admin-reports', 'reports', 'groupssettings', 'cloudidentity', 'licensing', 'reseller'];
const OPEN_SERVICE_SET = new Set(OPEN_SERVICES);

const SERVICE_WORDS = [...OPEN_SERVICES, ...GUARDED_SERVICES].join('|');
const GWS_MENTION = new RegExp(
  String.raw`(?:^|[\s"'\x60(=;|&/\\])gws(?:\.exe|\.cmd)?["']?\s+["']?(?:\+[a-z]|--(?:dry-run|format|sanitize|api-version|help|version)\b|(?:auth|schema|generate-skills)(?=[\s"']|$)|[a-z][a-z0-9-]*:[a-z0-9_.]+|(?:${SERVICE_WORDS})["']?\s+["']?(?:\+[a-z]|[a-z][a-z0-9_]*["']?\s+["']?[a-z]))`,
  'i',
);

const GLOBAL_VALUE_FLAGS = ['--format', '--sanitize', '--api-version'];
const HELP = new Set(['--help', '-h']);
const VERSION = new Set(['--version', '-V', 'version']);

const READ_METHODS = new Set(['get', 'list', 'export', 'getProfile', 'batchGet', 'query', 'search', 'generateIds']);
const CALENDAR_NOTIFYING = new Set(['insert', 'update', 'patch', 'move', 'quickAdd', 'import']);

const READ_HELPERS = new Set(['+read', '+triage', '+agenda', '+standup-report', '+meeting-prep', '+weekly-digest', '+sanitize-prompt', '+sanitize-response']);
const WRITE_HELPERS = new Set(['+write', '+append', '+watch', '+subscribe', '+renew', '+email-to-task', '+create-template']);
const SENSITIVE_HELPERS = new Map([
  ['+send', 'sends a message'],
  ['+reply', 'sends a message'],
  ['+reply-all', 'sends a message'],
  ['+forward', 'sends a message'],
  ['+file-announce', 'sends a message'],
  ['+insert', 'creates a calendar event, which can email attendees'],
  ['+upload', 'uploads local files'],
  ['+push', 'uploads local files'],
]);

const CREDENTIAL_VARS = String.raw`(?:GOOGLE_WORKSPACE_CLI_[A-Z0-9_]+|GOOGLE_APPLICATION_CREDENTIALS)`;
const SETS_CREDENTIALS = [
  new RegExp(String.raw`(?:^|[^A-Z0-9_])${CREDENTIAL_VARS}\s*=`, 'i'),
  new RegExp(String.raw`\bsetx\s+["']?${CREDENTIAL_VARS}\b`, 'i'),
  new RegExp(String.raw`\benv:${CREDENTIAL_VARS}\b`, 'i'),
  new RegExp(String.raw`SetEnvironmentVariable\(\s*["']${CREDENTIAL_VARS}\b`, 'i'),
];

export function setsGwsCredentials(command: string): boolean {
  return SETS_CREDENTIALS.some((pattern) => pattern.test(command));
}

export function classifyGws(segment: string): GwsCommand | null {
  const words = splitWords(segment);
  const start = words ? gwsArgsStart(words) : -1;
  if (!words || start < 0) {
    return GWS_PACKAGE_MENTION.test(segment) || GWS_MENTION.test(segment) ? unreadable() : null;
  }
  const args = argTokens(words.slice(start));
  return args ? classifyArgs(args) : unreadable();
}

function splitWords(segment: string): Word[] | null {
  const words: Word[] = [];
  let raw = '';
  let value = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    const next = segment[i + 1];
    if (quote) {
      if (quote === '"' && ch === '\\' && (next === '"' || next === '\\')) {
        raw += ch + next;
        value += next;
        i++;
        continue;
      }
      raw += ch;
      if (ch === quote) quote = '';
      else value += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) words.push({ raw, value });
      raw = '';
      value = '';
      started = false;
      continue;
    }
    started = true;
    if (ch === '"' || ch === "'") {
      quote = ch;
      raw += ch;
      continue;
    }
    if (ch === '\\' && next !== undefined && ' \t"\''.includes(next)) {
      raw += ch + next;
      value += next;
      i++;
      continue;
    }
    raw += ch;
    value += ch;
  }
  if (quote) return null;
  if (started) words.push({ raw, value });
  return words;
}

function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? '').toLowerCase();
}

function gwsArgsStart(words: Word[]): number {
  let i = 0;
  let wrapped = false;
  while (i < words.length) {
    const value = words[i].value;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value) || (wrapped && value.startsWith('-'))) {
      i++;
      continue;
    }
    if (WRAPPERS.has(programName(value))) {
      wrapped = true;
      i++;
      continue;
    }
    break;
  }
  if (i >= words.length) return -1;
  const program = programName(words[i].value);
  if (GWS_PROGRAMS.has(program)) return i + 1;
  const runner = program.replace(/\.(?:cmd|exe)$/, '');
  let j = i + 1;
  if (DLX_RUNNERS.has(runner)) {
    if (words[j]?.value !== 'dlx') return -1;
    j++;
  } else if (!PACKAGE_RUNNERS.has(runner)) {
    return -1;
  }
  while (j < words.length && RUNNER_FLAGS.has(words[j].value)) j++;
  return j < words.length && GWS_PACKAGE.test(words[j].value) ? j + 1 : -1;
}

function argTokens(words: Word[]): string[] | null {
  const tokens: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const raw = words[i].raw;
    if (/^\d*>>?$/.test(raw)) {
      i++;
      continue;
    }
    if (/^\d*>>?\S/.test(raw)) continue;
    const result = tokenizePosix(raw);
    if (!result.ok || result.argv.length !== 1) return null;
    tokens.push(result.argv[0]);
  }
  return tokens;
}

function firstArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--api-version') {
      i++;
      continue;
    }
    if (arg.startsWith('--') && arg !== '--help' && arg !== '--version') continue;
    return arg;
  }
  return undefined;
}

function scanPositionals(args: string[]): { positionals: string[]; rest: string[] } {
  const positionals: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (GLOBAL_VALUE_FLAGS.includes(arg)) {
      i += 2;
      continue;
    }
    if (arg === '--dry-run' || GLOBAL_VALUE_FLAGS.some((flag) => arg.startsWith(`${flag}=`))) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) break;
    positionals.push(arg);
    i++;
  }
  return { positionals, rest: args.slice(i) };
}

function classifyArgs(args: string[]): GwsCommand {
  const first = firstArg(args);
  if (first === undefined || HELP.has(first) || VERSION.has(first)) {
    return { kind: 'read', target: first ?? 'gws', reason: 'shows help or the version' };
  }
  const { positionals, rest } = scanPositionals(args);
  const top = positionals[0];
  if (first === 'auth' || top === 'auth') return authCommand(args);
  if (first === 'schema' || top === 'schema') return { kind: 'read', target: 'schema', reason: 'shows an API method' };
  if (first === 'generate-skills' || top === 'generate-skills') {
    return { kind: 'write', target: 'generate-skills', reason: 'writes skill files' };
  }
  if (args.some((arg) => /^--upload(?:=|$)/.test(arg))) return sensitive(undefined, 'upload', 'uploads a local file');
  if (positionals.length === 0) return unreadable('a flag comes before the gws service');

  const [service, ...chain] = positionals;
  const svc = service.split(':')[0].toLowerCase();
  if (chain.length === 0) {
    return rest.every((arg) => HELP.has(arg))
      ? { kind: 'read', service: svc, target: service, reason: 'shows help' }
      : unreadable();
  }
  const helper = chain.find((part) => part.startsWith('+'));
  if (helper) return classifyHelper(svc, helper);
  return classifyMethod(svc, chain.slice(0, -1), chain[chain.length - 1]);
}

function authCommand(args: string[]): GwsCommand {
  const sub = args[args.indexOf('auth') + 1];
  if (sub === 'status') return { kind: 'read', target: 'auth status', reason: 'shows the sign-in status' };
  return { kind: 'credentials', target: sub ? `auth ${sub}` : 'auth', reason: 'gws sign-in commands are for the owner' };
}

function classifyHelper(svc: string, helper: string): GwsCommand {
  if (READ_HELPERS.has(helper)) return { kind: 'read', service: svc, target: helper, reason: 'reads from Google Workspace' };
  if (WRITE_HELPERS.has(helper)) return { kind: 'write', service: svc, target: helper, reason: 'changes Google Workspace data' };
  return sensitive(svc, helper, SENSITIVE_HELPERS.get(helper) ?? 'is a gws helper Mercury does not know');
}

function classifyMethod(svc: string, resources: string[], method: string): GwsCommand {
  if (/^(?:batch)?delete/i.test(method) || method === 'emptyTrash') return sensitive(svc, method, 'deletes permanently');
  if (/^send/i.test(method)) return sensitive(svc, method, 'sends a message');
  if (READ_METHODS.has(method)) return { kind: 'read', service: svc, target: method, reason: 'reads from Google Workspace' };
  if (!OPEN_SERVICE_SET.has(svc)) return sensitive(svc, method, 'changes an admin or unlisted Google API');
  if (svc === 'gmail' && resources.includes('settings')) {
    return sensitive(svc, method, 'changes Gmail settings such as forwarding, filters or delegates');
  }
  if (svc === 'drive' && resources.includes('permissions')) return sensitive(svc, method, 'changes who a Drive file is shared with');
  if (svc === 'calendar') {
    if (method === 'clear') return sensitive(svc, method, 'deletes every event in a calendar');
    if (resources.includes('acl')) return sensitive(svc, method, 'changes who a calendar is shared with');
    if (resources.includes('events') && CALENDAR_NOTIFYING.has(method)) {
      return sensitive(svc, method, 'changes a calendar event, which can email attendees');
    }
  }
  if (svc === 'chat' && (resources.includes('messages') || resources.includes('members'))) {
    return sensitive(svc, method, 'posts to Google Chat or changes its members');
  }
  return { kind: 'write', service: svc, target: method, reason: 'changes Google Workspace data' };
}

function sensitive(service: string | undefined, target: string, reason: string): GwsCommand {
  return service ? { kind: 'sensitive', service, target, reason } : { kind: 'sensitive', target, reason };
}

function unreadable(reason = 'Mercury could not read this gws command'): GwsCommand {
  return { kind: 'sensitive', target: 'gws', reason };
}
