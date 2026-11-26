import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM plugin, no types
import { buildTask, answerOf, detectCaptchas, injectScript, solve, balance, activate } from '../../plugins/captcha/index.mjs';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function deps(over: Record<string, unknown> = {}) {
  let t = 0;
  let usage = { date: 'x', paid: 0, spent: 0 };
  const calls: string[] = [];
  const d = {
    settings: { service: '2captcha', useOwnModels: true, askMe: true, askTimeoutMinutes: 3, dailyLimit: 50 },
    secret: (n: string) => (n === 'TWOCAPTCHA_API_KEY' ? 'k' : undefined),
    fetch: vi.fn<(...a: any[]) => any>(),
    lookAt: vi.fn(async () => null),
    ask: vi.fn<(...a: any[]) => any>(async () => ({ status: 'expired' })),
    readFile: vi.fn(async () => PNG),
    readUsage: async () => usage,
    writeUsage: async (u: typeof usage) => { usage = u; },
    now: () => (t += 1000),
    sleep: async () => {},
    signal: undefined,
    calls,
    get usage() { return usage; },
    ...over,
  };
  return d;
}
const json = (body: unknown) => ({ ok: true, json: async () => body });

describe('task names per service (checked against their docs)', () => {
  const v2 = { type: 'recaptcha_v2', page_url: 'https://x.com', site_key: 'K' };
  it('reCAPTCHA v2', () => {
    expect(buildTask('2captcha', v2).type).toBe('RecaptchaV2TaskProxyless');
    expect(buildTask('anticaptcha', v2).type).toBe('RecaptchaV2TaskProxyless');
    expect(buildTask('capsolver', v2).type).toBe('ReCaptchaV2TaskProxyLess');
    expect(buildTask('capmonster', v2).type).toBe('RecaptchaV2Task');
    expect(buildTask('capsolver', { ...v2, enterprise: true }).type).toBe('ReCaptchaV2EnterpriseTaskProxyLess');
    expect(buildTask('2captcha', v2)).toMatchObject({ websiteURL: 'https://x.com', websiteKey: 'K' });
  });
  it('Turnstile carries action and cdata the way each service wants', () => {
    const ts = { type: 'turnstile', page_url: 'https://x.com', site_key: 'K', action: 'login', cdata: 'c' };
    expect(buildTask('2captcha', ts)).toMatchObject({ type: 'TurnstileTaskProxyless', action: 'login', data: 'c' });
    expect(buildTask('capsolver', ts)).toMatchObject({ type: 'AntiTurnstileTaskProxyLess', metadata: { action: 'login', cdata: 'c' } });
    expect(buildTask('capmonster', ts).type).toBe('TurnstileTask');
  });
  it('services that dropped a kind return null, so it falls through', () => {
    const h = { type: 'hcaptcha', page_url: 'https://x.com', site_key: 'K' };
    expect(buildTask('2captcha', h)).toBeNull();
    expect(buildTask('capsolver', h)).toBeNull();
    expect(buildTask('anticaptcha', h)).toBeNull();
    expect(buildTask('capsolver', { type: 'funcaptcha', page_url: 'u', site_key: 'K' })).toBeNull();
  });
  it('GeeTest v3 and v4, and the answer from each solution shape', () => {
    expect(buildTask('2captcha', { type: 'geetest', page_url: 'u', captcha_id: 'c' })).toMatchObject({ version: 4, initParameters: { captcha_id: 'c' } });
    expect(buildTask('capsolver', { type: 'geetest', page_url: 'u', gt: 'g', challenge: 'h' })).toMatchObject({ type: 'GeeTestTaskProxyLess', gt: 'g', challenge: 'h' });
    expect(answerOf('image', { text: 'abc' })).toBe('abc');
    expect(answerOf('recaptcha_v2', { gRecaptchaResponse: 'tok' })).toBe('tok');
    expect(answerOf('turnstile', { token: 'tt' })).toBe('tt');
    expect(JSON.parse(answerOf('geetest', { lot_number: '1' }))).toEqual({ lot_number: '1' });
  });
});

describe('detect', () => {
  it('finds reCAPTCHA v2/v3, Turnstile, hCaptcha and GeeTest with their solve arguments', () => {
    const html = `
      <div class="g-recaptcha" data-sitekey="6LcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" data-callback="onOk"></div>
      <script src="https://www.google.com/recaptcha/api.js?render=6LdBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"></script>
      <script>grecaptcha.execute('6LdBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', {action: 'submit'})</script>
      <div class="cf-turnstile" data-sitekey="0x4AAAAAAAAbbbbbb" data-action="login"></div>
      <div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div>
      <script>initGeetest4({captchaId: "e392e1d7fd421dc63325744d5a2b9c73"}) // geetest</script>`;
    const found = detectCaptchas(html, 'https://shop.example/login');
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'recaptcha_v2', site_key: '6LcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', callback: 'onOk', page_url: 'https://shop.example/login' }),
      expect.objectContaining({ type: 'recaptcha_v3', site_key: '6LdBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', action: 'submit' }),
      expect.objectContaining({ type: 'turnstile', site_key: '0x4AAAAAAAAbbbbbb', action: 'login' }),
      expect.objectContaining({ type: 'hcaptcha' }),
      expect.objectContaining({ type: 'geetest', captcha_id: 'e392e1d7fd421dc63325744d5a2b9c73' }),
    ]));
  });
  it('an image CAPTCHA is pointed at the image path route; a clean page finds nothing', () => {
    expect(detectCaptchas('<img src="/captcha.php?id=3">', 'u')[0]).toMatchObject({ type: 'image' });
    expect(detectCaptchas('<p>hello</p>', 'u')).toEqual([]);
  });
  it('the inject script sets the response field and calls the callback', () => {
    const s = injectScript('turnstile', 'tok"x', 'onOk');
    expect(s).toContain('cf-turnstile-response');
    expect(s).toContain(JSON.stringify('tok"x'));
    expect(s).toContain('"onOk"');
  });
});

describe('solve: cheapest first', () => {
  it('two of your models agreeing is free and never reaches the service', async () => {
    const d = deps({ lookAt: vi.fn()
      .mockResolvedValueOnce({ text: ' xK2p9 ', provider: 'ollamaLocal', model: 'qwen2.5-vl' })
      .mockResolvedValueOnce({ text: 'XK2P9', provider: 'anthropic', model: 'claude' }) });
    const r = await solve({ type: 'image', image_path: '/tmp/c.png' }, d);
    expect(r).toMatchObject({ solved: true, kind: 'text', value: 'xK2p9', method: 'own-model', by: 'ollamaLocal · qwen2.5-vl + anthropic · claude', cost: 0 });
    expect((d.lookAt.mock.calls as any)[1][0].exclude).toEqual(['ollamaLocal']);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('your models disagreeing (a 4 read as an A) goes on to the service', async () => {
    const d = deps({ lookAt: vi.fn()
      .mockResolvedValueOnce({ text: 'K7XMAP', provider: 'anthropic', model: 'haiku' })
      .mockResolvedValueOnce({ text: 'K7XM4P', provider: 'chatgptWeb', model: 'gpt' }) });
    d.fetch.mockResolvedValueOnce(json({ errorId: 0, status: 'ready', solution: { text: 'K7XM4P' }, cost: '0.001' }));
    const r = await solve({ type: 'image', image_path: '/tmp/c.png' }, d);
    expect(r).toMatchObject({ solved: true, value: 'K7XM4P', method: 'service' });
  });

  it('a model that refuses is skipped, and the next ones are asked', async () => {
    const d = deps({ lookAt: vi.fn()
      .mockResolvedValueOnce({ text: 'Sorry, I can’t help solve CAPTCHAs.', provider: 'chatgptWeb', model: 'gpt' })
      .mockResolvedValueOnce({ text: 'K7XM4P', provider: 'anthropic', model: 'haiku' })
      .mockResolvedValueOnce({ text: 'k7xm4p', provider: 'openrouter', model: 'gemini' }) });
    const r = await solve({ type: 'image', image_path: '/tmp/c.png' }, d);
    expect(r).toMatchObject({ solved: true, value: 'K7XM4P', by: 'anthropic · haiku + openrouter · gemini' });
    expect(d.lookAt.mock.calls.map((c: any[]) => c[0].exclude)).toEqual([[], ['chatgptWeb'], ['chatgptWeb', 'anthropic']]);
  });

  it('one model alone is used only when nothing else is available, and says so', async () => {
    const d = deps({ settings: { service: 'none', askMe: false }, lookAt: vi.fn().mockResolvedValueOnce({ text: 'ab12', provider: 'p', model: 'm' }).mockResolvedValueOnce(null) });
    expect(await solve({ type: 'image', image_path: '/tmp/c.png' }, d)).toMatchObject({ solved: true, value: 'ab12', note: expect.stringContaining('unconfirmed') });
  });

  it('unreadable to your model → the service, polled to the answer, counted against the day', async () => {
    const d = deps({ lookAt: vi.fn(async () => ({ text: 'UNREADABLE', provider: 'p', model: 'm' })) });
    d.fetch.mockResolvedValueOnce(json({ errorId: 0, taskId: 7 }))
      .mockResolvedValueOnce(json({ errorId: 0, status: 'processing' }))
      .mockResolvedValueOnce(json({ errorId: 0, status: 'ready', solution: { text: 'w8m3' }, cost: '0.001' }));
    {
      const r = await solve({ type: 'image', image_path: '/tmp/c.png' }, d);
      expect(r).toMatchObject({ solved: true, value: 'w8m3', method: 'service', by: '2Captcha', cost: 0.001 });
      const created = JSON.parse(d.fetch.mock.calls[0][1].body);
      expect(created).toMatchObject({ clientKey: 'k', task: { type: 'ImageToTextTask', body: PNG.toString('base64') } });
      expect(d.usage.paid).toBe(1);
    }
  });

  it('a token comes back with an inject script', async () => {
    const d = deps();
    d.fetch.mockResolvedValueOnce(json({ errorId: 0, taskId: 9 })).mockResolvedValueOnce(json({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: '03AG' }, cost: '0.00299' }));
    {
      const r = await solve({ type: 'recaptcha_v2', page_url: 'https://x.com', site_key: 'K', callback: 'cb' }, d);
      expect(r).toMatchObject({ solved: true, kind: 'token', value: '03AG', by: '2Captcha' });
      expect(r.inject).toContain('g-recaptcha-response');
    }
  });

  it('a kind the service dropped (hCaptcha) goes straight to the owner, who finishes it on the page', async () => {
    const d = deps({ ask: vi.fn(async () => ({ status: 'answered', answer: 'done' })) });
    const r = await solve({ type: 'hcaptcha', page_url: 'https://shop.example/login', site_key: 'K' }, d);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.ask).toHaveBeenCalledWith(expect.objectContaining({ answer: 'done', link: 'https://shop.example/login', title: 'Finish a CAPTCHA on shop.example' }));
    expect(r).toMatchObject({ solved: true, kind: 'done-by-owner', method: 'owner' });
  });

  it('service error → the owner gets the image and types the answer', async () => {
    const d = deps({ ask: vi.fn(async () => ({ status: 'answered', answer: ' Q7K2 ' })) });
    d.fetch.mockResolvedValueOnce(json({ errorId: 1, errorCode: 'ERROR_ZERO_BALANCE' }));
    const r = await solve({ type: 'image', image_path: '/tmp/c.png', avoid: ['own-model'] }, d);
    expect(d.lookAt).not.toHaveBeenCalled();
    expect(d.ask.mock.calls[0][0]).toMatchObject({ answer: 'text', media: { mimeType: 'image/png' } });
    expect(r).toMatchObject({ solved: true, value: 'Q7K2', method: 'owner' });
  });

  it('a bot\'s run: the owner is not asked, and the result says what was tried', async () => {
    const d = deps({ secret: () => undefined, ask: vi.fn(async () => ({ status: 'unavailable' })) });
    const r = await solve({ type: 'turnstile', page_url: 'https://x.com', site_key: 'K' }, d);
    expect(r.solved).toBe(false);
    expect(r.why).toContain('no API key set');
    expect(r.why).toContain('not asked (unattended run)');
  });

  it('the daily limit stops paid solves', async () => {
    const d = deps({ settings: { service: '2captcha', dailyLimit: 0, askMe: false } });
    const r = await solve({ type: 'turnstile', page_url: 'https://x.com', site_key: 'K' }, d);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(r.why).toContain("today's limit of 0");
  });

  it('missing arguments are explained, not sent', async () => {
    expect((await solve({ type: 'recaptcha_v2' }, deps())).why).toContain('captcha__detect');
    expect((await solve({ type: 'image' }, deps())).why).toContain('image_path');
    expect((await solve({ type: 'image', image_path: 'a.pdf' }, deps())).why).toContain('Unsupported');
  });

  it('balance reports the service and today\'s use', async () => {
    const d = deps();
    d.fetch.mockResolvedValueOnce(json({ errorId: 0, balance: 4.21 }));
    expect(await balance(d)).toBe('Today: 0 of 50 paid solves.\n2Captcha balance: $4.21');
  });
});

describe('the plugin registers exactly its declared tools', () => {
  it('solve, detect, balance', () => {
    const names: string[] = [];
    activate({ tools: { register: (t: { name: string }) => { names.push(t.name); return { dispose() {} }; } }, settings: { all: () => ({}) }, secrets: { get: () => undefined }, plugin: { dataDir: '/tmp' }, log: { info() {} } } as never);
    expect(names).toEqual(['solve', 'detect', 'balance']);
  });
});
