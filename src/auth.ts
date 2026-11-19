// Sign-in for a hosted deployment: one shared password, remembered per device with a signed cookie.
// Stateless: the cookie is an expiry time plus an HMAC keyed from the password, so changing the
// password signs every device out. HTTP Basic is still accepted (curl, scripts).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const COOKIE = 'tri_session';
export const SESSION_DAYS = 90;
const WINDOW_MS = 15 * 60 * 1000, PER_IP = 5, GLOBAL = 40;

const digest = (s: string) => createHash('sha256').update(s).digest();
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export function createAuth(password: string | undefined, now: () => number = Date.now) {
  const enabled = !!password;
  // Keyed from the password: a new password invalidates every existing session.
  const key = digest(`triathlon-session:${password ?? ''}`);
  const sign = (exp: string) => createHmac('sha256', key).update(exp).digest('base64url');
  const issue = (days = SESSION_DAYS) => { const exp = String(Math.floor(now() / 1000) + Math.round(days * 86400)); return `${exp}.${sign(exp)}`; };
  const validToken = (t: string) => {
    const [exp, mac, extra] = t.split('.');
    if (!exp || !mac || extra !== undefined || !/^\d{1,12}$/.test(exp) || Number(exp) < now() / 1000) return false;
    return same(Buffer.from(mac), Buffer.from(sign(exp)));
  };
  const cookieOf = (req: IncomingMessage) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return '';
  };
  const basicOk = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Basic ')) return false;
    // Everything after the first colon is the password; the username is ignored.
    return same(digest(Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':')), digest(password!));
  };
  const check = (req: IncomingMessage) => !enabled || validToken(cookieOf(req)) || basicOk(req);
  const passwordOk = (given: string) => enabled && same(digest(given), digest(password!));

  // Failed sign-ins: five per address and forty overall per 15 minutes. Fly puts the real client
  // address in Fly-Client-IP; forwarding headers a client can set itself are not trusted.
  const fails = new Map<string, number[]>();
  const ipOf = (req: IncomingMessage) => String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? '?');
  const recent = (k: string) => { const a = (fails.get(k) ?? []).filter((t) => t > now() - WINDOW_MS); fails.set(k, a); return a; };
  const lockedFor = (req: IncomingMessage) => {
    const mine = recent(ipOf(req)), all = recent('*');
    const until = Math.max(mine.length >= PER_IP ? mine[0] + WINDOW_MS : 0, all.length >= GLOBAL ? all[0] + WINDOW_MS : 0);
    return until > now() ? Math.ceil((until - now()) / 60000) : 0;
  };
  const fail = (req: IncomingMessage) => { recent(ipOf(req)).push(now()); recent('*').push(now()); };

  const secure = (req: IncomingMessage) => req.headers['x-forwarded-proto'] === 'https' || !!(req.socket as { encrypted?: boolean }).encrypted;
  const setCookie = (req: IncomingMessage) => `${COOKIE}=${issue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? '; Secure' : ''}`;
  const clearCookie = (req: IncomingMessage) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? '; Secure' : ''}`;
  return { enabled, check, passwordOk, lockedFor, fail, setCookie, clearCookie, issue, validToken };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function loginPage(error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Sign in · Triathlon Coach</title><style>
:root{--bg:#f4f5f7;--panel:#fff;--line:#dfe3e8;--text:#15181d;--muted:#646d7a;--accent:#0b6bcb;--bad:#c0392b}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--panel:#171b22;--line:#2b323d;--text:#e8ebf0;--muted:#98a2b1;--accent:#4da3ff;--bad:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:16px}
form{width:100%;max-width:340px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted);font-size:14px}label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input{width:100%;font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
button{width:100%;margin-top:18px;font:inherit;font-weight:600;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:var(--bad);font-size:14px;margin-top:12px}</style></head><body>
<form method="post" action="/login"><h1>Triathlon Coach</h1><p>Sign in once; this device stays signed in for ${SESSION_DAYS} days.</p>
<label for="u">Username (anything)</label><input id="u" name="username" autocomplete="username" value="athlete" autocapitalize="off">
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required autofocus>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}<button type="submit">Sign in</button></form></body></html>`;
}
