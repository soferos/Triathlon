import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAuth, COOKIE } from '../src/auth.ts';
import { createApp } from '../src/server.ts';

let app: Server, base: string, dir: string;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tri-auth-'));
  app = createApp({ dataDir: dir, today: () => '2026-11-11', password: 'correct horse' }).server;
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
after(() => { app.close(); rmSync(dir, { recursive: true, force: true }); });

const login = (password: string, ip?: string) => fetch(`${base}/login`, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(ip ? { 'fly-client-ip': ip } : {}) },
  body: new URLSearchParams({ username: 'anything', password }),
});
const cookieFrom = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

test('unauthenticated: pages redirect to the sign-in page, the API gets a plain 401 (no browser pop-up)', async () => {
  const page = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  const api = await fetch(base + '/api/state');
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('www-authenticate'), null);
  assert.equal((await fetch(base + '/app.js', { redirect: 'manual' })).status, 302);
  const form = await (await fetch(base + '/login')).text();
  assert.match(form, /autocomplete="current-password"/);
  assert.match(form, /90 days/);
});

test('signing in sets a long-lived HttpOnly cookie that then authorises the app and the API', async () => {
  const wrong = await login('nope');
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Wrong password/);
  const ok = await login('correct horse');
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/');
  const set = ok.headers.get('set-cookie')!;
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, new RegExp(`Max-Age=${90 * 86400}`));
  assert.doesNotMatch(set, /Secure/, 'plain http in the test: no Secure flag');
  const c = cookieFrom(ok);
  const state = await fetch(base + '/api/state', { headers: { cookie: c } });
  assert.equal(state.status, 200);
  assert.equal((await state.json() as any).auth.enabled, true);
  assert.equal((await fetch(base + '/', { headers: { cookie: c } })).status, 200);
  // an already signed-in device that opens the sign-in page goes straight to the app
  assert.equal((await fetch(base + '/login', { headers: { cookie: c }, redirect: 'manual' })).headers.get('location'), '/');
  // behind Fly's proxy the cookie is also marked Secure
  const secure = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' }, body: 'password=correct%20horse' });
  assert.match(secure.headers.get('set-cookie')!, /; Secure/);
  // HTTP Basic still works for scripts
  assert.equal((await fetch(base + '/api/state', { headers: { authorization: `Basic ${Buffer.from('x:correct horse').toString('base64')}` } })).status, 200);
  assert.equal((await fetch(base + '/api/state', { headers: { authorization: `Basic ${Buffer.from('x:wrong').toString('base64')}` } })).status, 401);
  // sign out clears it
  const out = await fetch(base + '/logout', { method: 'POST', headers: { cookie: c } });
  assert.match(out.headers.get('set-cookie')!, /Max-Age=0/);
});

test('cookies: tampered, expired, other-password and malformed ones are rejected; a new password signs everyone out', () => {
  let t = 1_000_000_000_000;
  const a = createAuth('pw one', () => t);
  const token = a.issue();
  assert.equal(a.validToken(token), true);
  const [exp, mac] = token.split('.');
  assert.equal(a.validToken(`${Number(exp) + 1000}.${mac}`), false, 'extending the expiry breaks the signature');
  assert.equal(a.validToken(`${exp}.${mac.slice(0, -2)}xx`), false);
  assert.equal(a.validToken(''), false);
  assert.equal(a.validToken('abc.def'), false);
  assert.equal(a.validToken(`${exp}.${mac}.extra`), false);
  assert.equal(createAuth('pw two', () => t).validToken(token), false, 'a different password invalidates old sessions');
  t += 91 * 86400 * 1000;
  assert.equal(a.validToken(token), false, 'expired after 90 days');
  assert.equal(createAuth(undefined).check({ headers: {}, socket: {} } as any), true, 'no password configured: open (local use)');
  assert.equal(COOKIE, 'tri_session');
});

test('repeated wrong passwords lock the address out, even for the right password, without affecting others', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login('guess', '203.0.113.9')).status, 401);
  const locked = await login('correct horse', '203.0.113.9');
  assert.equal(locked.status, 429);
  assert.match(await locked.text(), /Try again in \d+ minute/);
  assert.equal((await login('correct horse', '198.51.100.7')).status, 303, 'another address is unaffected');
});
