'use strict';
// Remote sessions: an opt-in HTTP server that lets another Qwen Workspace (paired with this
// device's URL and pairing code) list this device's conversations, read their transcripts,
// send messages into them, start new tasks, and stop runs. The pairing code is a bearer
// token checked in constant time on every request. SECURITY: whoever holds the code can
// drive this PC's agent with this PC's approval settings — pair only over a private network
// (Tailscale) and treat the code like a password. Nothing here runs unless the user turns
// "Allow other devices" on; the server lives and dies with the app.
//
// createHandler is pure-ish (all effects behind injected deps), so tests drive it with a
// plain http server and fakes.

const http = require('http');
const crypto = require('crypto');

// A readable pairing code: QW-XXXX-XXXX-XXXX from the cryptographic RNG.
function makeToken() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return `QW-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function tokenOk(authHeader, token) {
  if (!token) return false;
  const given = Buffer.from(String(authHeader || '').replace(/^Bearer\s+/i, '').trim());
  const want = Buffer.from(String(token));
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// deps: {
//   token():string, info():object,
//   listConvs():[], loadConv(id):object|null,
//   startConversation({text,title}):Promise<{ok,id?,error?,code?}>,
//   sendMessage(id,{text}):Promise<{ok,error?,code?}>,
//   stop(id):Promise<{ok,error?,code?}>
// }
function createHandler(deps) {
  return async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url, 'http://local');
      if (!url.pathname.startsWith('/qw/')) return send(404, { error: 'Not found' });
      if (!tokenOk(req.headers.authorization, deps.token())) return send(401, { error: 'Bad or missing pairing code' });

      if (req.method === 'GET' && url.pathname === '/qw/ping') return send(200, deps.info());
      if (req.method === 'GET' && url.pathname === '/qw/conversations') {
        return send(200, deps.listConvs().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 100));
      }

      const one = /^\/qw\/conversations\/([\w-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && one) {
        const c = deps.loadConv(one[1]);
        if (!c) return send(404, { error: 'No such conversation' });
        // The viewer needs the rendered transcript, not the raw model history (which can
        // carry attached file contents): send display + the viewer-relevant fields.
        return send(200, {
          id: c.id, title: c.title, workspace: c.workspace, status: c.status, mode: c.mode,
          model: c.model, updatedAt: c.updatedAt, todos: c.todos || [], display: c.display || []
        });
      }

      if (req.method === 'POST' && url.pathname === '/qw/conversations') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const text = String(body.text || '').slice(0, 20000).trim();
        if (!text) return send(400, { error: 'text is required' });
        const r = await deps.startConversation({ text, title: String(body.title || '').slice(0, 100) });
        return send(r.ok ? 202 : r.code || 409, r);
      }

      const action = /^\/qw\/conversations\/([\w-]+)\/(message|stop)$/.exec(url.pathname);
      if (req.method === 'POST' && action) {
        const [, id, kind] = action;
        if (kind === 'stop') {
          const r = await deps.stop(id);
          return send(r.ok ? 202 : r.code || 409, r);
        }
        const body = JSON.parse((await readBody(req)) || '{}');
        const text = String(body.text || '').slice(0, 20000).trim();
        if (!text) return send(400, { error: 'text is required' });
        const r = await deps.sendMessage(id, { text });
        return send(r.ok ? 202 : r.code || 409, r);
      }

      return send(404, { error: 'Not found' });
    } catch (e) {
      return send(500, { error: String(e.message || e).slice(0, 300) });
    }
  };
}

// The running server, swapped whenever the settings change.
let server = null;
let current = { enabled: false, port: 0 };

function syncServer(settings, deps, log = () => {}) {
  const want = settings?.remoteAccess || {};
  const enabled = !!want.enabled;
  const port = Math.max(1024, Math.min(65535, parseInt(want.port, 10) || 8931));
  if (enabled === current.enabled && port === current.port && server) return;
  if (server) {
    try {
      server.close();
    } catch {
      /* already down */
    }
    server = null;
  }
  current = { enabled, port };
  if (!enabled) return;
  server = http.createServer(createHandler(deps));
  server.on('error', (e) => log(`Remote sessions server error: ${e.message}`));
  server.listen(port, () => log(`Remote sessions listening on :${port}`));
}

function serverState() {
  return { running: !!server && current.enabled, port: current.port };
}

module.exports = { makeToken, tokenOk, createHandler, syncServer, serverState };
