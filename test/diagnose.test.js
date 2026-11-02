const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/renderer/diagnose.js');

const step = (name, ok, detail, ms) => ({ step: name, ok, detail, ms });

test('diagVerdict: per-app blocking is named, with the loopback control as evidence', () => {
  // The field case: EACCES on Windows while the app's loopback connections work.
  const steps = [step('parse', true, '100.88.91.13:11434'), step('tcp', false, 'EACCES', 3), step('control', true, 'loopback 11434 answers', 5)];
  const v = D.diagVerdict(steps, 'win32');
  assert.ok(v.includes('EACCES'));
  assert.ok(/VPN app.*NordVPN/.test(v), v); // the field culprit is named first
  assert.ok(/firewall rule, or security software/.test(v), v);
  assert.ok(/only outbound\/remote traffic is being filtered/.test(v));
  // On macOS the same errno points at the Local Network permission instead.
  const mac = D.diagVerdict([step('parse', true, 'x'), step('tcp', false, 'EPERM', 2)], 'darwin');
  assert.ok(/Local Network/.test(mac));
});

test('diagVerdict: refused, timeout, wrong service and healthy all read differently', () => {
  const refused = D.diagVerdict([step('parse', true, 'x'), step('tcp', false, 'ECONNREFUSED', 1), step('control', true, 'ok', 2)], 'win32');
  assert.ok(/nothing is listening/.test(refused));
  assert.ok(/portproxy/.test(refused)); // the relay setup is a first-class suspect
  const timeout = D.diagVerdict([step('parse', true, 'x'), step('tcp', false, 'ETIMEDOUT', 5000)], 'win32');
  assert.ok(/off or asleep|Tailscale/.test(timeout));
  const wrong = D.diagVerdict([step('parse', true, 'x'), step('tcp', true, 'connected', 3), step('http', false, 'HTTP 404', 10)], 'win32');
  assert.ok(/does not speak Ollama/.test(wrong));
  const fine = D.diagVerdict([step('parse', true, 'x'), step('tcp', true, 'connected', 3), step('http', true, 'Ollama 0.40.13 answered', 12)], 'win32');
  assert.ok(/Everything works/.test(fine));
  const badUrl = D.diagVerdict([step('parse', false, 'not an http(s) URL')], 'win32');
  assert.ok(/not a valid/.test(badUrl));
});

test('diagVerdict: a failed loopback control is ambiguous, not an accusation', () => {
  // The control probe hits localhost:11434 — a PC that simply runs no local Ollama must not
  // be told "the app is blocked" as a certainty.
  const v = D.diagVerdict([step('parse', true, 'x'), step('tcp', false, 'EHOSTUNREACH', 9), step('control', false, 'ECONNREFUSED', 1)], 'win32');
  assert.ok(/no local Ollama/.test(v), v);
  assert.ok(/or the app itself is blocked/.test(v), v);
});

test('diagReport lists every probe and ends with the verdict and app line', () => {
  const steps = [step('parse', true, 'host:11434'), step('tcp', false, 'EACCES', 4), step('env', true, 'no proxy environment variables')];
  const r = D.diagReport('Alien', 'http://host:11434', steps, 'win32', '0.24.1');
  assert.ok(r.startsWith('Connection doctor — Alien (http://host:11434)'));
  assert.ok(r.includes('FAIL tcp      EACCES (4ms)'));
  assert.ok(r.includes('OK   env      no proxy environment variables'));
  assert.ok(r.includes('Verdict: '));
  assert.ok(r.includes('App 0.24.1 on win32'));
});
