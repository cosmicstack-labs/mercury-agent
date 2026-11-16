// Lets an iPhone on your Wi-Fi reach the Mercury on this computer while you work on the app:
//   node apps/ios/scripts/lan-relay.mjs [port=6175]
// then in the app connect to http://<this-mac>.local:<port>.
//
// Mercury only listens on 127.0.0.1. This listens on the network and forwards to it,
// adding X-Forwarded-For, so Mercury treats the phone as a remote device: it must be
// approved, and sensitive changes ask the owner (website/docs/desktop/remote-access.mdx).
// It carries plain requests, live streams (SSE) and the call WebSocket. Plain HTTP: use it
// on a network you trust; for anywhere else use Tailscale or Cloudflare Tunnel.
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

const target = { host: '127.0.0.1', port: Number(process.env.MERCURY_PORT ?? 6174) };
const port = Number(process.argv[2] ?? 6175);

function forwarded(req) {
  const client = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  return { ...req.headers, 'x-forwarded-for': client, 'x-forwarded-proto': 'http', 'x-forwarded-host': req.headers.host ?? '' };
}

// One line per request (no headers or bodies, so no tokens): who asked for what, and the answer.
function log(req, status, started) {
  const who = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const path = (req.url ?? '').replace(/([?&](ticket|token)=)[^&]+/g, '$1…');
  console.log(`${new Date().toISOString().slice(11, 19)} ${who} ${req.method} ${path} → ${status} (${Date.now() - started} ms)`);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const up = http.request({ ...target, method: req.method, path: req.url, headers: forwarded(req) }, (r) => {
    log(req, r.statusCode ?? 502, started);
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    log(req, 502, started);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Mercury isn\'t running on this computer.');
  });
  req.pipe(up);
  // A stream the phone closed (a chat it left) ends upstream too.
  res.on('close', () => up.destroy());
});

// WebSockets (real-time calls): pass the upgrade through, then splice the two sockets.
server.on('upgrade', (req, socket, head) => {
  log(req, 'upgrade', Date.now());
  const up = net.connect(target.port, target.host, () => {
    const headers = Object.entries(forwarded(req)).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`));
    up.write([`${req.method} ${req.url} HTTP/1.1`, ...headers, '', ''].join('\r\n'));
    if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(port, '0.0.0.0', () => {
  const name = os.hostname().replace(/\.local$/, '');
  console.log(`Relaying http://${name}.local:${port} → http://${target.host}:${target.port}`);
});
