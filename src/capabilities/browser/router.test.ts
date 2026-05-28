import { describe, expect, it } from 'vitest';
import { isDomainAllowed, addAllowedDomain } from './router.js';
import { PermissionManager } from '../permissions.js';

/**
 * Tests for domain allowlist behavior. Full chooseBackend() routing is
 * integration-tested against live backends in Phase 3 because it threads
 * through the BrowserSessionManager singleton (probe + API-key state).
 */
describe('domain allowlist', () => {
  function freshManager(): PermissionManager {
    const m = new PermissionManager();
    // Reset to a known empty state — tests must not depend on previously saved domains.
    const manifest = m.getManifest();
    manifest.capabilities.browser = { enabled: true, allowedDomains: [] };
    return m;
  }

  it('returns false for an unlisted host', () => {
    const m = freshManager();
    expect(isDomainAllowed(m, 'example.com')).toBe(false);
  });

  it('returns true for an exactly-matched listed host', () => {
    const m = freshManager();
    m.getManifest().capabilities.browser!.allowedDomains.push('example.com');
    expect(isDomainAllowed(m, 'example.com')).toBe(true);
  });

  it('matches subdomains of a listed host (suffix match)', () => {
    const m = freshManager();
    m.getManifest().capabilities.browser!.allowedDomains.push('example.com');
    expect(isDomainAllowed(m, 'www.example.com')).toBe(true);
    expect(isDomainAllowed(m, 'a.b.c.example.com')).toBe(true);
  });

  it('does NOT match unrelated hosts that happen to end with similar text', () => {
    const m = freshManager();
    m.getManifest().capabilities.browser!.allowedDomains.push('example.com');
    expect(isDomainAllowed(m, 'notexample.com')).toBe(false);
    expect(isDomainAllowed(m, 'example.com.evil.io')).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    const m = freshManager();
    m.getManifest().capabilities.browser!.allowedDomains.push('Example.COM');
    expect(isDomainAllowed(m, 'WWW.example.com')).toBe(true);
  });

  it('addAllowedDomain is idempotent and lowercased', () => {
    const m = freshManager();
    addAllowedDomain(m, 'Foo.BAR');
    addAllowedDomain(m, 'foo.bar');
    addAllowedDomain(m, 'FOO.BAR');
    const list = m.getManifest().capabilities.browser!.allowedDomains;
    expect(list.filter((d) => d === 'foo.bar')).toHaveLength(1);
  });
});
