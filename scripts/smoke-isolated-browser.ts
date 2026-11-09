/** Compile and run this fixture with Bun to exercise the same pipe/spawn path
 * shipped in Mercury's standalone/desktop binaries. No real websites/accounts. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { IsolatedBrowserReader } from '../src/capabilities/browser/reader.js';
import { browserUrl } from '../src/capabilities/browser/public-request.js';

let privateHits = 0;
const server = createServer((req, res) => {
  if (req.url?.startsWith('/private')) privateHits++;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<h1>Compiled reader ${req.url}</h1><script>document.body.innerHTML='SCRIPT-RAN'</script><img src="${origin}/private-image">`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = new IsolatedBrowserReader({ transport: async (url, signal, budget) => {
  browserUrl(url.href);
  assert.equal(url.hostname, 'fixture.public.example');
  const response = await fetch(origin + url.pathname, { signal, redirect: 'manual' });
  const body = Buffer.from(await response.arrayBuffer());
  budget.consume(body.length);
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
} });
try {
  const a = await browser.run('compiled-a', 'navigate', 'https://fixture.public.example/a');
  assert(a?.text.includes('Compiled reader /a'));
  assert(!a.text.includes('SCRIPT-RAN'));
  assert(a.image.startsWith('/9j/'));
  await browser.run('compiled-b', 'navigate', 'https://fixture.public.example/b');
  await assert.rejects(browser.run('compiled-c', 'navigate', 'https://fixture.public.example/c'), /Two isolated/);
  assert((await browser.run('compiled-a', 'snapshot'))?.text.includes('Compiled reader /a'));
  assert((await browser.run('compiled-b', 'snapshot'))?.text.includes('Compiled reader /b'));
  await assert.rejects(browser.run('compiled-c', 'navigate', `${origin}/private-direct`));
  assert.equal(privateHits, 0);
  await browser.closeAll();
  await assert.rejects(browser.run('compiled-a', 'snapshot'), /No isolated page/);
  process.stdout.write(`Compiled browser smoke passed (${process.platform}; Bun ${process.versions.bun ?? 'unknown'}).\n`);
} finally {
  await browser.closeAll();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
