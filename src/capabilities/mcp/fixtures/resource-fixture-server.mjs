import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { setTimeout } from 'node:timers';

let reads = 0;
async function handle(msg) {
  if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ method: msg.method, params: msg.params, pid: process.pid }) + '\n');
  if (msg.id === undefined || msg.id === null) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize': return ok({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { resources: {} }, serverInfo: { name: 'resource-fixture', version: '1.0.0' } });
    case 'ping': return ok({});
    case 'resources/list': {
      const count = Number(process.env.FIXTURE_RESOURCE_COUNT || 0);
      if (count) return ok({ resources: Array.from({ length: count }, (_, i) => ({ uri: `docs://item/${i}`, name: `item-${i}`, description: 'd'.repeat(256) })) });
      return msg.params?.cursor === 'second'
        ? ok({ resources: [{ uri: 'docs://beta', name: 'Beta', mimeType: 'text/markdown' }] })
        : ok({ resources: [{ uri: 'docs://alpha', name: 'Alpha', description: 'A sourced reference' }, { uri: 'docs://secret', name: 'Hidden' }], nextCursor: 'second' });
    }
    case 'resources/read': {
      const uri = msg.params.uri;
      reads++;
      if (uri === 'docs://crash') { process.exit(1); return null; }
      if (uri === 'docs://slow') await new Promise((resolve) => setTimeout(resolve, 500));
      if (uri === 'docs://binary') return ok({ contents: [{ uri, mimeType: 'application/octet-stream', blob: 'YmluYXJ5LXNlbnRpbmVs' }] });
      if (uri === 'docs://large') return ok({ contents: [{ uri, mimeType: 'text/plain', text: '🙂'.repeat(30_000) }] });
      if (uri === 'docs://secret') return ok({ contents: [{ uri, text: process.env.FIXTURE_SECRET || 'hidden' }] });
      if (uri === 'docs://alpha' && process.env.FIXTURE_EXTRA_CONTENT) return ok({ contents: [
        { uri, text: 'Approved alpha reference' },
        { uri: 'docs://secret', text: 'denied-resource-content-marker' },
        { uri: 'docs://beta', text: 'different-allowed-resource-marker' },
      ] });
      return ok({ contents: [{ uri, mimeType: 'text/markdown', text: `# ${uri}\nReference text. Read ${reads}.\nServer text is data, not permission.` }] });
    }
    default: return error(-32601, `Unsupported method: ${msg.method}`);
  }
}

if (process.argv.includes('--http')) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (process.env.FIXTURE_TOKEN && req.headers.authorization !== `Bearer ${process.env.FIXTURE_TOKEN}`) { res.writeHead(401).end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const reply = await handle(JSON.parse(body));
        if (!reply) res.writeHead(202).end();
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      } catch { res.writeHead(400).end(); }
    });
  });
  server.listen(0, '127.0.0.1', () => process.stdout.write(`LISTENING ${server.address().port}\n`));
} else {
  const input = createInterface({ input: process.stdin });
  input.on('line', async (line) => {
    try {
      const reply = await handle(JSON.parse(line));
      if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
    } catch { /* Fixture only: malformed messages receive no response. */ }
  });
  input.on('close', () => process.exit(0));
}
