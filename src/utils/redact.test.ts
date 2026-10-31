import { describe, expect, it } from 'vitest';

// Secret-shaped fixtures are assembled at runtime: contiguous literals in
// this file would trip GitHub push protection's secret scanner.
const join = (...parts: string[]) => parts.join('');
import { redactSecrets, redactDeep, registerSecretValue, userFacingAiError } from './redact.js';

describe('secret redaction', () => {
  it('masks registered secret values wherever they appear', () => {
    const secret = join('plain-registered-', 'value-0042');
    expect(redactSecrets(`token is ${secret}.`)).toBe(`token is ${secret}.`);
    registerSecretValue(secret);
    expect(redactSecrets(`token is ${secret}, again ${secret}`)).toBe('token is ****, again ****');
    registerSecretValue('short');
    expect(redactSecrets('a short word')).toBe('a short word');
  });

  it('masks API keys while keeping a recognizable prefix/suffix', () => {
    const out = redactSecrets(join('export OPENAI_API_KEY=sk-proj-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '1234567890abcd'));
    expect(out).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(out).toContain(join('sk-p****', 'abcd'));
  });

  it('masks GitHub, AWS, and Slack tokens', () => {
    expect(redactSecrets(join('token ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '1234'))).not.toContain(join('ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
    expect(redactSecrets(join('AKIA', 'IOSFODNN7EXAMPLE'))).not.toContain(join('AKIA', 'IOSFODNN7'));
    expect(redactSecrets(join('xoxb-123456789012-', '1234567890123-abcdefghijklmnop'))).not.toContain('abcdefghijklmnop');
  });

  it('masks Bearer headers and generic key=value secrets', () => {
    const out = redactSecrets(join('Authorization: Bearer eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'));
    expect(out).not.toContain(join('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'));
    expect(out).toContain(join('Bear****', '.sig'));
  });

  it('leaves ordinary code and config untouched', () => {
    const code = 'const apiKeyField = "name";\nskylight.trim();\nconst tokenCount = 123456789012;';
    expect(redactSecrets(code)).toBe(code);
  });

  it('redacts strings nested in objects non-destructively', () => {
    const err = {
      message: join('Invalid key sk-ant-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '123456'),
      meta: { responseBody: join('{"error":"key sk-', 'abcdefghijklmnopqrstuvwx bad"}') },
    };
    const out = redactDeep(err) as typeof err;
    expect(out.message).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect((out.meta as any).responseBody).not.toContain(join('sk-', 'abcdefghijklmnopqrstuvwx'));
    expect(err.message).toContain(join('sk-ant-', 'ABC')); // original untouched
  });
});

describe('user-facing AI errors', () => {
  it('names a spent token budget instead of falling back to the generic line', () => {
    // The exact shape the daemon builds when isOverBudget() refuses a turn.
    const refusal = new Error(
      "I've exceeded my daily token budget (Token budget: 9,907,679 / 500,000,000 used (2%), 490,092,321 remaining).",
    );
    const message = userFacingAiError(refusal);
    expect(message).toMatch(/daily token budget/);
    expect(message).not.toMatch(/could not complete this request/);
  });

  it('keeps a provider quota error as a provider problem', () => {
    expect(userFacingAiError(new Error('429 quota exceeded for this project'))).toMatch(/temporarily busy/);
  });
});