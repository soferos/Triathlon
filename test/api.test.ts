import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

// A fake Intervals.icu that records what the app sends.
const icu = { events: [] as any[], calls: [] as string[], auth: '' };
let fake: Server, app: Server, base: string, dir: string;
const TODAY = '2026-11-11';

before(async () => {
  fake = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    icu.calls.push(`${req.method} ${req.url}`);
    icu.auth = req.headers.authorization ?? '';
    const json = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (icu.auth !== `Basic ${Buffer.from('API_KEY:secret-key').toString('base64')}`) return json(401, {});
    const url = new URL(req.url!, 'http://x');
    const path = url.pathname.replace(/^\/api\/v1\/athlete\/(0|i12345)/, '');
    if (req.method === 'GET' && path === '') {
      return json(200, { id: 'i12345', name: 'Test Athlete', icu_weight: 71, sportSettings: [
        { types: ['Ride', 'VirtualRide'], ftp: 285, lthr: 168 },
        { types: ['Run'], ftp: 345, lthr: 172, threshold_pace: 4.2553 },
        { types: ['Swim'], threshold_pace: 1.0989 },
      ] });
    }
    if (req.method === 'GET' && path === '/wellness') {
      return json(200, Array.from({ length: 30 }, (_, i) => ({ id: `2026-10-${String(i + 1).padStart(2, '0')}`, ctl: 40 + i * 0.1, atl: 42, hrv: 70, restingHR: 46 })));
    }
    if (req.method === 'GET' && path === '/activities') return json(200, [{ id: 'a1', start_date_local: '2026-11-10T07:00:00', type: 'Ride', name: 'Ride', moving_time: 3600, icu_training_load: 55, distance: 30000 }]);
    if (req.method === 'GET' && path === '/events') {
      return json(200, [...icu.events, { id: 999, category: 'RACE_A', name: 'Imported 70.3', start_date_local: '2027-07-04T00:00:00', type: 'Triathlon' }]
        .filter((e) => e.start_date_local.slice(0, 10) >= url.searchParams.get('oldest')! && e.start_date_local.slice(0, 10) <= url.searchParams.get('newest')!));
    }
    if (req.method === 'POST' && path === '/events/bulk') {
      for (const e of JSON.parse(raw)) {
        const i = icu.events.findIndex((x) => x.external_id === e.external_id);
        if (i >= 0) icu.events[i] = { ...icu.events[i], ...e }; else icu.events.push({ id: icu.events.length + 1, ...e });
      }
      return json(200, icu.events);
    }
    if (req.method === 'DELETE' && path.startsWith('/events/')) {
      icu.events = icu.events.filter((e) => String(e.id) !== path.split('/')[2]);
      return json(200, {});
    }
    json(404, {});
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  process.env.INTERVALS_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'tri-'));
  const { createApp } = await import('../src/server.ts');
  app = createApp({ dataDir: dir, today: () => TODAY }).server;
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
after(() => { app.close(); fake.close(); rmSync(dir, { recursive: true, force: true }); });

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() as any };
};

test('serves the UI and an initial state', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<title>/);
  const { data } = await api('GET', '/api/state');
  assert.equal(data.today, TODAY);
  assert.equal(data.intervals.connected, false);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
});

test('rejects bad Intervals.icu credentials without storing them', async () => {
  const r = await api('POST', '/api/intervals/connect', { apiKey: 'wrong' });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /credentials/);
  assert.equal((await api('GET', '/api/state')).data.intervals.connected, false);
});

test('connect: syncs thresholds, fitness, activities and races; key never reaches the browser', async () => {
  const r = await api('POST', '/api/intervals/connect', { apiKey: 'secret-key' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.importedRaces, 1);
  const { data } = await api('GET', '/api/state');
  assert.equal(data.intervals.connected, true);
  assert.equal(data.intervals.athleteName, 'Test Athlete');
  assert.equal(data.profile.ftp, 285);
  assert.equal(data.profile.runPower, 345);
  assert.equal(data.profile.runPaceSecPerKm, 235);
  assert.equal(data.profile.cssSecPer100, 91);
  assert.ok(Math.abs(data.ctl - 42.9) < 0.01);
  assert.ok(!JSON.stringify(data).includes('secret-key'));
  assert.ok(readFileSync(join(dir, 'state.json'), 'utf8').includes('secret-key'));
});

test('generate, customise and push the plan; stale events are removed on the next push', async () => {
  await api('PUT', '/api/races', [{ name: 'Main 70.3', date: '2027-06-27', type: 'half', priority: 'A' }]);
  const g = await api('POST', '/api/plan/generate', {});
  assert.equal(g.status, 200);
  let { data } = await api('GET', '/api/state');
  assert.ok(data.sessions.length > 20);
  assert.ok(data.season.weeks.length > 30);
  assert.ok(data.sessions[0].workout.view !== undefined);

  const lib = await api('POST', '/api/library', { workout: { sport: 'run', name: 'Track 6x800', blocks: [{ name: 'Reps', repeat: 6, steps: [{ kind: 'work', secs: 170, lo: 1.06, hi: 1.1 }, { kind: 'recovery', secs: 120, lo: 0.65, hi: 0.7 }] }] } });
  assert.equal(lib.status, 200);
  data = (await api('GET', '/api/state')).data;
  const add = await api('POST', '/api/sessions', { date: '2026-11-13', libraryId: data.library[0].id });
  assert.equal(add.status, 200);

  const push = await api('POST', '/api/intervals/push', { days: 7 });
  assert.equal(push.status, 200, JSON.stringify(push.data));
  assert.ok(push.data.pushed >= 5);
  assert.equal(icu.events.length, push.data.pushed);
  const ev = icu.events.find((e) => e.name === 'Track 6x800');
  assert.equal(ev.category, 'WORKOUT');
  assert.equal(ev.type, 'Run');
  assert.equal(ev.start_date_local, '2026-11-13T00:00:00');
  assert.match(ev.description, /Reps 6x\n- 2m50s 106-110%\n- 2m 65-70%/);
  assert.ok(icu.events.every((e) => e.external_id.startsWith('tricoach-')));

  await api('DELETE', `/api/sessions/${add.data.id}`);
  const again = await api('POST', '/api/intervals/push', { days: 7 });
  assert.equal(again.data.removed, 1);
  assert.ok(!icu.events.some((e) => e.name === 'Track 6x800'));
});

test('session edits, check-in driven adaptation and calendar export', async () => {
  let { data } = await api('GET', '/api/state');
  const x = data.sessions.find((q: any) => q.date > TODAY);
  assert.equal((await api('PATCH', `/api/sessions/${x.id}`, { date: 'nope' })).status, 400);
  assert.equal((await api('PATCH', `/api/sessions/${x.id}`, { status: 'skipped' })).status, 200);
  await api('POST', '/api/checkin', { fatigue: 5, soreness: 4, sleepHours: 5, symptoms: true });
  data = (await api('GET', '/api/state')).data;
  assert.equal(data.readiness.status, 'recover');
  const applied = await api('POST', '/api/readiness/apply', {});
  assert.equal(applied.status, 200);
  const ics = await (await fetch(base + '/api/plan.ics')).text();
  assert.match(ics, /BEGIN:VEVENT/);
  assert.equal((await api('PUT', '/api/availability', { days: [] })).status, 400);
  assert.equal((await api('DELETE', '/api/intervals')).status, 200);
});
