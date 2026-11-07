import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const tools = [
  {
    name: 'echo',
    description: 'Echo the given text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'big',
    description: 'Return a long text result.',
    inputSchema: { type: 'object', properties: { size: { type: 'number' } } },
  },
  {
    name: 'image',
    description: 'Return a 1x1 PNG and a caption.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_env',
    description: 'Return the value of an environment variable visible to the server.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'fail',
    description: 'Always return an error result.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'crash',
    description: 'Reply, then exit the server process.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_tool',
    description: 'Register an extra tool and announce tools/list_changed.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];

const text = (t) => ({ content: [{ type: 'text', text: t }] });

function callTool(name, args, notify) {
  switch (name) {
    case 'echo':
      return text(String(args.text));
    case 'add':
      return text(String(Number(args.a) + Number(args.b)));
    case 'big':
      return text('x'.repeat(Number(args.size) || 100_000));
    case 'image':
      return {
        content: [
          { type: 'text', text: 'a pixel' },
          { type: 'image', data: TINY_PNG, mimeType: 'image/png' },
        ],
      };
    case 'read_env':
      return text(process.env[String(args.name)] ?? '(unset)');
    case 'fail':
      return { content: [{ type: 'text', text: 'it failed' }], isError: true };
    case 'crash':
      setTimeout(() => process.exit(1), 20);
      return text('bye');
    case 'add_tool':
      tools.push({
        name: String(args.name),
        description: 'Added at runtime.',
        inputSchema: { type: 'object', properties: {} },
      });
      notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return text('added');
    default:
      return null;
  }
}

function handle(msg, notify) {
  if (msg.id === undefined || msg.id === null) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'mercury-fixture', version: '1.0.0' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      if (process.env.FIXTURE_EXIT_AFTER_LIST) setTimeout(() => process.exit(1), 20);
      return ok({ tools });
    case 'tools/call': {
      const result = callTool(msg.params?.name, msg.params?.arguments ?? {}, notify);
      return result ? ok(result) : err(-32602, `Unknown tool: ${msg.params?.name}`);
    }
    default:
      return err(-32601, `Method not found: ${msg.method}`);
  }
}

if (process.env.FIXTURE_STDERR_SECRET) {
  process.stderr.write(`starting with token ${process.env.FIXTURE_STDERR_SECRET}\n`);
}

const httpIndex = process.argv.indexOf('--http');
if (process.env.FIXTURE_EXIT_AT_START) {
  process.exitCode = 3;
} else if (httpIndex !== -1) {
  const port = Number(process.argv[httpIndex + 1] ?? 0);
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const auth = process.env.FIXTURE_REQUIRE_TOKEN;
    if (auth && req.headers.authorization !== `Bearer ${auth}`) {
      res.writeHead(401).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const reply = handle(msg, () => {});
      if (!reply) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`LISTENING ${server.address().port}\n`);
  });
} else {
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const reply = handle(msg, send);
    if (reply) send(reply);
  });
  rl.on('close', () => process.exit(0));
}
