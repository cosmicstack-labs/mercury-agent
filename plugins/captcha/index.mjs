// CAPTCHA Solver for Mercury (Plugin API 1.3).
//
// One solve tries, cheapest first:
//   1. the owner's own models (any provider they set up that sees images), for image CAPTCHAs;
//   2. a solving service with the owner's key: 2Captcha, CapSolver, Anti-Captcha or CapMonster
//      (they share the createTask / getTaskResult protocol; only task names differ);
//   3. the owner, through Mercury's owner tasks (ADR-048): the CAPTCHA goes to their phone,
//      chats and Mercury Desktop, and their answer comes back. Never in a bot's run.
// It never guesses, and it never evades bot detection: it answers the CAPTCHA, nothing else.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Whole solve, inside Mercury's 5-minute tool cap. */
const BUDGET_MS = 285_000;
const POLL_MS = 3_000;
const SERVICE_MAX_MS = 150_000;

export const SERVICES = {
  '2captcha': { name: '2Captcha', base: 'https://api.2captcha.com', secret: 'TWOCAPTCHA_API_KEY' },
  capsolver: { name: 'CapSolver', base: 'https://api.capsolver.com', secret: 'CAPSOLVER_API_KEY' },
  anticaptcha: { name: 'Anti-Captcha', base: 'https://api.anti-captcha.com', secret: 'ANTICAPTCHA_API_KEY' },
  capmonster: { name: 'CapMonster Cloud', base: 'https://api.capmonster.cloud', secret: 'CAPMONSTER_API_KEY' },
};

export const TYPES = ['image', 'recaptcha_v2', 'recaptcha_v3', 'turnstile', 'geetest', 'funcaptcha', 'hcaptcha', 'audio'];

/**
 * The createTask body for a service, or null when that service doesn't solve this kind.
 * Task names checked against each service's docs (2026-11): hCaptcha is no longer offered
 * by 2Captcha, CapSolver or Anti-Captcha; FunCaptcha only by 2Captcha and Anti-Captcha.
 */
export function buildTask(service, a) {
  const url = a.page_url;
  const key = a.site_key;
  const capsolver = service === 'capsolver';
  const capmonster = service === 'capmonster';
  switch (a.type) {
    case 'image':
      return { type: 'ImageToTextTask', body: a.imageBase64, ...(a.case_sensitive ? { case: true } : {}) };
    case 'recaptcha_v2': {
      const enterprise = !!a.enterprise;
      const type = capsolver ? (enterprise ? 'ReCaptchaV2EnterpriseTaskProxyLess' : 'ReCaptchaV2TaskProxyLess')
        : capmonster ? (enterprise ? 'RecaptchaV2EnterpriseTask' : 'RecaptchaV2Task')
        : (enterprise ? 'RecaptchaV2EnterpriseTaskProxyless' : 'RecaptchaV2TaskProxyless');
      return { type, websiteURL: url, websiteKey: key, ...(a.invisible ? { isInvisible: true } : {}), ...(a.data_s ? { recaptchaDataSValue: a.data_s } : {}) };
    }
    case 'recaptcha_v3': {
      const enterprise = !!a.enterprise;
      if (capsolver) return { type: enterprise ? 'ReCaptchaV3EnterpriseTaskProxyLess' : 'ReCaptchaV3TaskProxyLess', websiteURL: url, websiteKey: key, ...(a.action ? { pageAction: a.action } : {}) };
      if (service === 'anticaptcha' && enterprise) return { type: 'RecaptchaV3Enterprise', websiteURL: url, websiteKey: key, minScore: a.min_score ?? 0.7, ...(a.action ? { pageAction: a.action } : {}) };
      return { type: 'RecaptchaV3TaskProxyless', websiteURL: url, websiteKey: key, minScore: a.min_score ?? 0.7, ...(a.action ? { pageAction: a.action } : {}), ...(enterprise ? { isEnterprise: true } : {}) };
    }
    case 'turnstile':
      if (capsolver) return { type: 'AntiTurnstileTaskProxyLess', websiteURL: url, websiteKey: key, ...(a.action || a.cdata ? { metadata: { ...(a.action ? { action: a.action } : {}), ...(a.cdata ? { cdata: a.cdata } : {}) } } : {}) };
      return { type: capmonster ? 'TurnstileTask' : 'TurnstileTaskProxyless', websiteURL: url, websiteKey: key, ...(a.action ? { action: a.action } : {}), ...(a.cdata ? { data: a.cdata } : {}) };
    case 'geetest': {
      const v4 = !!a.captcha_id;
      if (capsolver) return { type: 'GeeTestTaskProxyLess', websiteURL: url, ...(v4 ? { captchaId: a.captcha_id } : { gt: a.gt, challenge: a.challenge }) };
      return {
        type: capmonster ? 'GeeTestTask' : 'GeeTestTaskProxyless', websiteURL: url,
        ...(v4 ? { version: 4, initParameters: { captcha_id: a.captcha_id } } : { gt: a.gt, challenge: a.challenge }),
      };
    }
    case 'funcaptcha':
      if (service !== '2captcha' && service !== 'anticaptcha') return null;
      return { type: 'FunCaptchaTaskProxyless', websiteURL: url, websitePublicKey: key };
    case 'hcaptcha':
      return capmonster ? { type: 'HCaptchaTask', websiteURL: url, websiteKey: key } : null;
    default:
      return null;
  }
}

/** The answer in a service's solution: text, a token, or (GeeTest) the whole object. */
export function answerOf(type, solution) {
  if (!solution || typeof solution !== 'object') return null;
  if (type === 'image') return typeof solution.text === 'string' ? solution.text : null;
  if (type === 'geetest') return JSON.stringify(solution);
  const token = solution.gRecaptchaResponse ?? solution.token;
  return typeof token === 'string' && token ? token : null;
}

// ── detection ──────────────────────────────────────────────────────────────

const attr = (tag, name) => new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];

/** CAPTCHAs in a page's HTML, with the solve arguments for each. */
export function detectCaptchas(html, pageUrl) {
  const found = [];
  const add = (item) => { if (!found.some((f) => f.type === item.type && f.site_key === item.site_key)) found.push(item); };
  const tags = html.match(/<[a-z][^>]*>/gi) ?? [];
  const enterprise = /recaptcha\/enterprise\.js/i.test(html);
  for (const tag of tags) {
    const cls = attr(tag, 'class') ?? '';
    const sitekey = attr(tag, 'data-sitekey');
    if (/\bg-recaptcha\b/.test(cls) && sitekey) add({ type: 'recaptcha_v2', site_key: sitekey, page_url: pageUrl, invisible: attr(tag, 'data-size') === 'invisible' || undefined, enterprise: enterprise || undefined, data_s: attr(tag, 'data-s'), callback: attr(tag, 'data-callback') });
    if (/\bh-captcha\b/.test(cls) && sitekey) add({ type: 'hcaptcha', site_key: sitekey, page_url: pageUrl, callback: attr(tag, 'data-callback') });
    if (/\bcf-turnstile\b/.test(cls) && sitekey) add({ type: 'turnstile', site_key: sitekey, page_url: pageUrl, action: attr(tag, 'data-action'), cdata: attr(tag, 'data-cdata'), callback: attr(tag, 'data-callback') });
    const pkey = attr(tag, 'data-pkey');
    if (pkey) add({ type: 'funcaptcha', site_key: pkey, page_url: pageUrl });
  }
  const v3 = /recaptcha\/(?:api|enterprise)\.js\?[^"'\s>]*render=([\w-]{20,})/i.exec(html) ?? /grecaptcha(?:\.enterprise)?\.execute\(\s*["']([\w-]{20,})["']/i.exec(html);
  if (v3 && v3[1] !== 'explicit') {
    const action = /action\s*:\s*["']([\w/]+)["']/i.exec(html)?.[1];
    add({ type: 'recaptcha_v3', site_key: v3[1], page_url: pageUrl, action, enterprise: enterprise || undefined });
  }
  const render = /grecaptcha(?:\.enterprise)?\.render\([^)]*sitekey["']?\s*:\s*["']([\w-]{20,})["']/i.exec(html);
  if (render) add({ type: 'recaptcha_v2', site_key: render[1], page_url: pageUrl, enterprise: enterprise || undefined });
  const ts = /turnstile\.render\([^)]*sitekey["']?\s*:\s*["']([\w-]{10,})["']/i.exec(html);
  if (ts) add({ type: 'turnstile', site_key: ts[1], page_url: pageUrl });
  const g4 = /captcha_?[Ii]d["']?\s*[:=]\s*["']([0-9a-f]{32})["']/.exec(html);
  if (g4 && /geetest|gt4/i.test(html)) add({ type: 'geetest', captcha_id: g4[1], page_url: pageUrl });
  const gt = /["']?gt["']?\s*:\s*["']([0-9a-f]{32})["']/i.exec(html);
  const ch = /["']?challenge["']?\s*:\s*["']([0-9a-f]{32,})["']/i.exec(html);
  if (gt && ch) add({ type: 'geetest', gt: gt[1], challenge: ch[1], page_url: pageUrl });
  if (!found.length && /<img[^>]+(captcha|verify|security[-_ ]?code)[^>]*>/i.test(html)) {
    found.push({ type: 'image', page_url: pageUrl, note: 'An image CAPTCHA: screenshot just the image, save it, and pass it as image_path.' });
  }
  return found.map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)));
}

/** JavaScript to put a token into the page (Playwright page.evaluate / a browser console). */
export function injectScript(type, token, callback) {
  const t = JSON.stringify(token);
  const names = type === 'turnstile' ? ['cf-turnstile-response'] : type === 'hcaptcha' ? ['h-captcha-response', 'g-recaptcha-response'] : ['g-recaptcha-response'];
  const cb = callback ? JSON.stringify(callback) : 'null';
  return `(() => { const t = ${t}; for (const n of ${JSON.stringify(names)}) for (const el of document.querySelectorAll('[name="' + n + '"]')) { el.value = t; el.innerHTML = t; } `
    + `const cb = ${cb} || document.querySelector('[data-callback]')?.getAttribute('data-callback'); `
    + `if (cb) { const f = cb.split('.').reduce((o, k) => o && o[k], window); if (typeof f === 'function') f(t); } return true; })()`;
}

// ── the plugin ─────────────────────────────────────────────────────────────

const today = () => new Date().toLocaleDateString('en-CA');

async function readUsage(dir) {
  try {
    const u = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8'));
    return u.date === today() ? u : { date: today(), paid: 0, spent: 0 };
  } catch { return { date: today(), paid: 0, spent: 0 }; }
}

async function writeUsage(dir, u) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'usage.json'), JSON.stringify(u));
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const h = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(h); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

const READ_PROMPT = 'This image is a CAPTCHA on a website the owner is using. Reply with exactly the characters it shows, in order, with no spaces or other words. If you cannot read every character with confidence, reply UNREADABLE.';

/** A model's reading, cleaned, or null when it couldn't read it. */
function readable(r) {
  const text = r?.text?.replace(/\s+/g, '').replace(/^["'`]|["'`.]$/g, '');
  return text && text.toUpperCase() !== 'UNREADABLE' && /^[\p{L}\p{N}]{2,16}$/u.test(text) ? { ...r, text } : null;
}

const same = (x, y, caseSensitive) => (caseSensitive ? x === y : x.toLowerCase() === y.toLowerCase());

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', m4a: 'audio/mp4' };

/** Run one solve. Exported for tests: `deps` replaces ctx pieces. */
export async function solve(args, deps) {
  const started = deps.now();
  const left = () => BUDGET_MS - (deps.now() - started);
  const tried = [];
  const a = { ...args };
  if (!TYPES.includes(a.type)) return { solved: false, why: `Unknown type "${a.type}". Use one of: ${TYPES.join(', ')}.` };
  const avoid = new Set(Array.isArray(a.avoid) ? a.avoid : []);

  // Media for image/audio CAPTCHAs.
  let media = null;
  if (a.type === 'image' || a.type === 'audio') {
    const path = a.image_path ?? a.audio_path;
    if (!path) return { solved: false, why: `type "${a.type}" needs ${a.type === 'image' ? 'image_path' : 'audio_path'}: save the CAPTCHA (just the image, or the audio clip) to a file first.` };
    const ext = String(path).split('.').pop().toLowerCase();
    const mimeType = (a.type === 'image' ? IMAGE_MIME : AUDIO_MIME)[ext];
    if (!mimeType) return { solved: false, why: `Unsupported ${a.type} file .${ext}.` };
    let data;
    try { data = await deps.readFile(path); } catch (e) { return { solved: false, why: `Couldn't read ${path}: ${e.message}` }; }
    if (data.length > 5 * 1024 * 1024) return { solved: false, why: 'The file is larger than 5 MB: crop to just the CAPTCHA.' };
    media = { mimeType, data: new Uint8Array(data) };
    a.imageBase64 = Buffer.from(data).toString('base64');
  } else if (!a.page_url || (!a.site_key && !a.captcha_id && !a.gt)) {
    return { solved: false, why: `type "${a.type}" needs page_url and site_key (GeeTest: gt + challenge, or captcha_id). Run captcha__detect on the page HTML to get them.` };
  }

  // 1. The owner's own models: image CAPTCHAs only, free.
  if (a.type === 'image' && deps.settings.useOwnModels !== false && !avoid.has('own-model')) {
    // Two of the owner's models must read the same thing: one model alone
    // misreads (a 4 as an A) often enough to burn a login attempt. A model
    // that refuses or can't read it is skipped and the next one is asked.
    tried.push('own models');
    try {
      const readings = [];
      const asked = [];
      const by = (r) => `${r.provider} · ${r.model}`;
      for (let i = 0; i < 3 && readings.length < 2; i++) {
        const raw = await deps.lookAt({ prompt: READ_PROMPT, image: media, exclude: [...asked] });
        if (!raw) break; // no more models that can see images
        asked.push(raw.provider);
        const r = readable(raw);
        if (r) readings.push(r);
      }
      const [first, second] = readings;
      if (first && second && same(first.text, second.text, a.case_sensitive)) {
        return { solved: true, kind: 'text', value: first.text, method: 'own-model', by: `${by(first)} + ${by(second)}`, cost: 0, note: 'Two of your models read the same text. If the site still rejects it, call again with avoid: ["own-model"].' };
      }
      if (first && second) tried.push(`own models disagreed (${first.text} vs ${second.text})`);
      else if (first && deps.settings.service === 'none' && deps.settings.askMe === false) {
        // Nothing else to try: one model's reading is better than nothing, flagged as such.
        return { solved: true, kind: 'text', value: first.text, method: 'own-model', by: by(first), cost: 0, note: 'Only one of your models could read it, unconfirmed. If the site rejects it, the CAPTCHA was misread.' };
      } else if (first) tried.push('only one of your models could read it (unconfirmed)');
      else tried.push(asked.length ? `your models couldn't read it (${asked.join(', ')})` : 'none of your models can see images');
    } catch (e) { tried.push(`own models failed: ${e.message}`); }
  }

  // 2. The solving service.
  const serviceId = deps.settings.service ?? '2captcha';
  const service = SERVICES[serviceId];
  if (service && !avoid.has('service')) {
    const key = deps.secret(service.secret);
    const limit = Number(deps.settings.dailyLimit ?? 50);
    const usage = await deps.readUsage();
    const task = buildTask(serviceId, a);
    if (!key) tried.push(`${service.name}: no API key set (/plugins captcha)`);
    else if (!task) tried.push(`${service.name}: doesn't solve ${a.type}`);
    else if (usage.paid >= limit) tried.push(`${service.name}: today's limit of ${limit} paid solves is used up`);
    else {
      tried.push(service.name);
      const r = await runService(service, key, task, a.type, Math.min(SERVICE_MAX_MS, left() - 20_000), deps);
      if (r.ok) {
        await deps.writeUsage({ ...usage, paid: usage.paid + 1, spent: Math.round((usage.spent + (r.cost ?? 0)) * 100000) / 100000 });
        const kind = a.type === 'image' ? 'text' : a.type === 'geetest' ? 'geetest' : 'token';
        return {
          solved: true, kind, value: r.answer, method: 'service', by: service.name, cost: r.cost,
          ...(kind === 'token' ? { inject: injectScript(a.type, r.answer, a.callback), note: 'Tokens expire in about 2 minutes: submit right away.' } : {}),
          ...(kind === 'geetest' ? { note: 'Submit these values with the form (geetest_challenge, geetest_validate, geetest_seccode, or the v4 fields).' } : {}),
        };
      }
      tried.push(`${service.name}: ${r.why}`);
    }
  } else if (!service) tried.push('no solving service chosen');

  // 3. The owner. A token CAPTCHA can't be solved from a picture: they finish it on the page.
  if (deps.settings.askMe !== false && !avoid.has('owner')) {
    const minutes = Math.max(1, Math.min(4, Math.floor(Math.min(Number(deps.settings.askTimeoutMinutes ?? 3), (left() - 10_000) / 60_000))));
    if (left() > 70_000) {
      tried.push('you');
      const visual = a.type === 'image' || a.type === 'audio';
      const site = (() => { try { return new URL(a.page_url).host; } catch { return 'a website'; } })();
      const r = await deps.ask({
        title: visual ? 'Solve this CAPTCHA' : `Finish a CAPTCHA on ${site}`,
        prompt: visual
          ? `Mercury is stuck on a CAPTCHA${a.page_url ? ` on ${site}` : ''}. ${a.type === 'audio' ? 'Listen and type what it says.' : 'Type the characters you see.'}`
          : `Mercury hit a ${a.type.replace('_', ' ')} check on ${site} that couldn't be solved automatically. Open the page, complete the check there, then reply done.`,
        ...(media ? { media } : {}),
        ...(a.page_url ? { link: a.page_url } : {}),
        answer: visual ? 'text' : 'done',
        timeoutMinutes: minutes,
      });
      if (r.status === 'answered') {
        return visual
          ? { solved: true, kind: 'text', value: r.answer.trim(), method: 'owner', by: 'you', cost: 0 }
          : { solved: true, kind: 'done-by-owner', value: null, method: 'owner', by: 'you', cost: 0, note: 'The owner completed the check on their own device. Reload the page and continue; this session did not receive a token.' };
      }
      tried.push(r.status === 'unavailable' ? 'you: not asked (unattended run)' : `you: ${r.status}`);
    } else tried.push('you: not enough time left to ask');
  }

  return { solved: false, why: `Couldn't solve this ${a.type} CAPTCHA. Tried: ${tried.join('; ') || 'nothing available'}.`, tried };
}

async function runService(service, key, task, type, maxMs, deps) {
  const post = async (path, body) => {
    const res = await deps.fetch(`${service.base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: key, ...body }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && !json.errorId) return { errorId: 1, errorCode: `HTTP_${res.status}`, errorDescription: res.statusText };
    return json;
  };
  const describe = (j) => `${j.errorCode ?? 'error'}${j.errorDescription ? ` (${j.errorDescription})` : ''}`;
  try {
    const created = await post('createTask', { task });
    if (created.errorId) return { ok: false, why: describe(created) };
    // Some services answer image tasks at once.
    if (created.status === 'ready' && created.solution) {
      const answer = answerOf(type, created.solution);
      return answer ? { ok: true, answer, cost: Number(created.cost ?? 0) || 0 } : { ok: false, why: 'empty solution' };
    }
    const end = deps.now() + Math.max(10_000, maxMs);
    const wait = deps.sleep ?? sleep;
    await wait(type === 'image' ? POLL_MS : 8_000, deps.signal);
    while (deps.now() < end) {
      const r = await post('getTaskResult', { taskId: created.taskId });
      if (r.errorId) return { ok: false, why: describe(r) };
      if (r.status === 'ready') {
        const answer = answerOf(type, r.solution);
        return answer ? { ok: true, answer, cost: Number(r.cost ?? 0) || 0 } : { ok: false, why: 'empty solution' };
      }
      await wait(POLL_MS, deps.signal);
    }
    return { ok: false, why: `no result in ${Math.round(maxMs / 1000)}s` };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

export async function balance(deps) {
  const serviceId = deps.settings.service ?? '2captcha';
  const service = SERVICES[serviceId];
  const usage = await deps.readUsage();
  const limit = Number(deps.settings.dailyLimit ?? 50);
  const lines = [`Today: ${usage.paid} of ${limit} paid solves${usage.spent ? `, $${usage.spent}` : ''}.`];
  if (!service) return [...lines, 'No solving service chosen.'].join('\n');
  const key = deps.secret(service.secret);
  if (!key) return [...lines, `${service.name}: no API key set (/plugins captcha).`].join('\n');
  try {
    const res = await deps.fetch(`${service.base}/getBalance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: key }) });
    const j = await res.json();
    lines.push(j.errorId ? `${service.name}: ${j.errorCode ?? 'error'}${j.errorDescription ? ` (${j.errorDescription})` : ''}` : `${service.name} balance: $${j.balance}`);
  } catch (e) { lines.push(`${service.name}: ${e.message}`); }
  return lines.join('\n');
}

const SOLVE_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: TYPES, description: 'Which CAPTCHA (captcha__detect tells you).' },
    image_path: { type: 'string', description: 'type image: a file with just the CAPTCHA image.' },
    audio_path: { type: 'string', description: 'type audio: the audio challenge file.' },
    page_url: { type: 'string', description: 'The page the CAPTCHA is on.' },
    site_key: { type: 'string', description: 'data-sitekey (reCAPTCHA, hCaptcha, Turnstile) or the FunCaptcha public key.' },
    action: { type: 'string', description: 'reCAPTCHA v3 / Turnstile action, if the page sets one.' },
    min_score: { type: 'number', description: 'reCAPTCHA v3 score wanted (default 0.7).' },
    enterprise: { type: 'boolean', description: 'reCAPTCHA Enterprise.' },
    invisible: { type: 'boolean', description: 'Invisible reCAPTCHA v2.' },
    data_s: { type: 'string', description: 'reCAPTCHA data-s, if present.' },
    cdata: { type: 'string', description: 'Turnstile data-cdata, if present.' },
    gt: { type: 'string', description: 'GeeTest v3 gt.' },
    challenge: { type: 'string', description: 'GeeTest v3 challenge (fresh, from the page).' },
    captcha_id: { type: 'string', description: 'GeeTest v4 captcha_id.' },
    callback: { type: 'string', description: 'The page\'s data-callback function, to call after injecting a token.' },
    case_sensitive: { type: 'boolean', description: 'type image: letters are case-sensitive.' },
    avoid: { type: 'array', items: { type: 'string', enum: ['own-model', 'service', 'owner'] }, description: 'Skip these on a retry (e.g. the site rejected the own-model answer).' },
  },
  required: ['type'],
};

export function activate(ctx) {
  const deps = (signal) => ({
    settings: ctx.settings.all(),
    secret: (name) => ctx.secrets.get(name),
    fetch: (url, init) => ctx.fetch(url, { ...init, signal }),
    lookAt: (req) => ctx.models.lookAt({ ...req, maxModels: 1, signal }),
    ask: (req) => ctx.owner.ask({ ...req, signal }),
    readFile: (p) => readFile(p),
    readUsage: () => readUsage(ctx.plugin.dataDir),
    writeUsage: (u) => writeUsage(ctx.plugin.dataDir, u),
    now: () => Date.now(),
    signal,
  });

  ctx.tools.register({
    name: 'solve',
    inputSchema: SOLVE_SCHEMA,
    execute: async (args, { signal }) => {
      const r = await solve(args, deps(signal));
      ctx.log.info('captcha solve', { type: args.type, solved: r.solved, method: r.method, by: r.by, cost: r.cost });
      return r;
    },
  });

  ctx.tools.register({
    name: 'detect',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The page HTML.' },
        html_path: { type: 'string', description: 'Or a file with the page HTML.' },
        page_url: { type: 'string', description: 'The page address (needed to solve).' },
      },
    },
    execute: async (args) => {
      const html = typeof args.html === 'string' ? args.html : args.html_path ? await readFile(String(args.html_path), 'utf8') : '';
      if (!html) return { found: [], note: 'Pass html or html_path.' };
      const found = detectCaptchas(html.slice(0, 2_000_000), typeof args.page_url === 'string' ? args.page_url : undefined);
      return found.length
        ? { found, note: 'Pass one of these to captcha__solve as-is.' }
        : { found: [], note: 'No known CAPTCHA in this HTML. It may load later (wait, then read the page again) or sit inside an iframe.' };
    },
  });

  ctx.tools.register({
    name: 'balance',
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, { signal }) => balance(deps(signal)),
  });
}
