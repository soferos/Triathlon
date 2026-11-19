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
    const oldest = url.searchParams.get('oldest') ?? '', newest = url.searchParams.get('newest') ?? '';
    const inRange = (d: string) => d.slice(0, 10) >= oldest && d.slice(0, 10) <= newest;
    if (req.method === 'GET' && path === '/wellness') {
      return json(200, [
        ...Array.from({ length: 30 }, (_, i) => ({ id: `2026-10-${String(i + 1).padStart(2, '0')}`, ctl: 40 + i * 0.1, atl: 42, hrv: 70, restingHR: 46 })),
        { id: '2025-07-01', ctl: 88, atl: 90 },
      ].filter((w) => inRange(w.id)));
    }
    if (req.method === 'GET' && path === '/activities') {
      return json(200, [
        { id: 'a1', start_date_local: '2026-11-10T07:00:00', type: 'Ride', name: 'Ride', moving_time: 3600, icu_training_load: 55, distance: 30000, icu_weighted_avg_watts: 231, average_heartrate: 138, icu_intensity: 81.2 },
        { id: 'a2', start_date_local: '2025-07-01T07:00:00', type: 'Run', name: 'Long run', moving_time: 5400, icu_training_load: 95, distance: 21000 },
        { id: 'a3', start_date_local: '2025-06-01T07:00:00', type: 'VirtualRide', name: 'Zwift', moving_time: 3600, icu_training_load: 70, distance: 35000 },
        { id: 'a4', start_date_local: '2024-03-02T07:00:00', type: 'GravelRide', name: 'Gravel', moving_time: 14400, icu_training_load: 200, distance: 120000 },
        { id: 'st1', start_date_local: '2024-05-02T07:00:00', source: 'STRAVA', _note: 'STRAVA activities are not available via the API' },
      ].filter((a) => inRange(a.start_date_local)));
    }
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
  assert.equal(data.history.count, 4);
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

test('full history import walks back year by year, merges on re-sync and reports Strava-hidden activities', async () => {
  icu.calls.length = 0;
  const r = await api('POST', '/api/intervals/connect', { apiKey: 'secret-key' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const actCalls = icu.calls.filter((c) => c.includes('/activities?'));
  assert.ok(actCalls.length >= 4, `expected yearly chunks, got ${actCalls.length}`);
  assert.equal(r.data.activities, 4);          // 1 recent + 3 older years' worth from the fake
  assert.equal(r.data.hidden, 1);
  assert.equal(r.data.historyFrom, '2024-03-02');
  const { data } = await api('GET', '/api/state');
  assert.equal(data.history.count, 4);
  assert.equal(data.history.peakCtl.value, 88);
  assert.ok(data.history.years.some((y: any) => y.year === '2024' && y.km.bike === 120));
  assert.equal(data.intervals.hidden, 1);
  const page = await api('GET', '/api/history?limit=2&sport=bike');
  assert.equal(page.data.total, 3);
  assert.equal(page.data.items[0].date, '2026-11-10');
  assert.equal(page.data.items[0].np, 231);
  // incremental sync keeps the old history and only refreshes the recent window
  icu.calls.length = 0;
  const again = await api('POST', '/api/intervals/sync', {});
  assert.equal(again.data.activities, 4);
  assert.equal(icu.calls.filter((c) => c.includes('/activities?')).length, 1);
});

test('race course, target splits and niggles round-trip through the API', async () => {
  await api('PUT', '/api/races', [{ name: 'Course race', date: '2027-06-27', type: 'half', priority: 'A' }]);
  let { data } = await api('GET', '/api/state');
  const race = data.races.find((r: any) => r.name === 'Course race');
  const pts: number[][] = [];
  for (let i = 0; i <= 800; i++) pts.push([45, 7 + (i * 50) / 78850, 100 + (i > 200 && i <= 300 ? (i - 200) * 2.5 : i > 300 && i <= 400 ? (400 - i) * 2.5 : 0)]);
  assert.equal((await api('PUT', `/api/races/${race.id}`, { bikePoints: [[1, 2, 3]] })).status, 400);
  const r = await api('PUT', `/api/races/${race.id}`, { bikePoints: pts, tempC: 28, cda: 0.25, podium: { swim: 1740, bike: 4200, run: 4920 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // saving the race list again must not drop the course
  await api('PUT', '/api/races', [{ id: race.id, name: 'Course race', date: '2027-06-27', type: 'half', priority: 'A' }]);
  data = (await api('GET', '/api/state')).data;
  const saved = data.races.find((q: any) => q.id === race.id);
  assert.ok(Math.abs(saved.course.bike.km - 40) < 0.3);
  assert.equal(saved.course.bike.climbs.length, 1);
  assert.equal(saved.course.tempC, 28);
  assert.equal(saved.podium.bike, 4200);
  assert.equal(saved.analysis.demands.hot, true);
  assert.ok(saved.analysis.prediction.bike.np > 0);
  assert.equal(saved.analysis.gap.rows.length, 3);
  assert.equal((await api('PUT', '/api/races/nope', {})).status, 404);

  assert.equal((await api('POST', '/api/niggles', { area: '' })).status, 400);
  await api('POST', '/api/niggles', { area: 'right knee', sport: 'run', severity: 3 });
  data = (await api('GET', '/api/state')).data;
  assert.equal(data.niggles.length, 1);
  assert.equal((await api('PATCH', `/api/niggles/${data.niggles[0].id}`, { resolved: true })).status, 200);
  assert.equal((await api('GET', '/api/state')).data.niggles.length, 0);
  assert.ok('comeback' in data.insights && 'ramp' in data.insights);
});

test('undo, device sync state, quick edits, availability preview and duplicate races', async () => {
  // fresh, connected, with a plan
  await api('POST', '/api/intervals/connect', { apiKey: 'secret-key' });
  await api('PUT', '/api/races', [{ name: 'Main 70.3', date: '2027-06-27', type: 'half', priority: 'A' }]);
  const dup = await api('PUT', '/api/races', [{ name: 'Main 70.3', date: '2027-06-27', type: 'half', priority: 'A' }, { name: 'main 70.3', date: '2027-06-27', type: 'half', priority: 'B' }]);
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /listed twice/);
  await api('POST', '/api/plan/generate', { scope: 'week' });
  let { data } = await api('GET', '/api/state');
  assert.equal(data.unsynced.never, true);
  await api('POST', '/api/intervals/push', { days: 14 });
  data = (await api('GET', '/api/state')).data;
  assert.deepEqual(data.unsynced, { changed: 0, removed: 0, never: false });

  // quick edit an easy session: +15 min, pinned, flagged as not on the device, and undoable
  const easy = data.sessions.find((x: any) => x.date > TODAY && x.status === 'planned' && ['bike.endurance', 'run.easy'].includes(x.workout.code));
  const r = await api('PATCH', `/api/sessions/${easy.id}`, { minutes: easy.workout.durationMin + 15 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  data = (await api('GET', '/api/state')).data;
  const after = data.sessions.find((x: any) => x.id === easy.id);
  assert.ok(Math.abs(after.workout.durationMin - easy.workout.durationMin - 15) <= 5);
  assert.equal(after.locked, true);
  assert.equal(data.unsynced.changed, 1);
  assert.match(data.undo.label, /Change to/);
  await api('DELETE', `/api/sessions/${easy.id}`);
  assert.equal((await api('GET', '/api/state')).data.unsynced.removed, 1);
  assert.equal((await api('POST', '/api/undo', {})).status, 200);   // delete undone
  assert.equal((await api('POST', '/api/undo', {})).status, 200);   // resize undone
  data = (await api('GET', '/api/state')).data;
  assert.equal(data.sessions.find((x: any) => x.id === easy.id).workout.durationMin, easy.workout.durationMin);
  assert.deepEqual([data.unsynced.changed, data.unsynced.removed], [0, 0]);
  // a hard session cannot be resized, but can be made easy
  const hard = data.sessions.find((x: any) => x.workout.hard && x.sport === 'bike' && x.status === 'planned' && x.date > TODAY);
  if (hard) {
    assert.equal((await api('PATCH', `/api/sessions/${hard.id}`, { minutes: 30 })).status, 400);
    assert.equal((await api('PATCH', `/api/sessions/${hard.id}`, { easy: true })).status, 200);
    assert.equal((await api('GET', '/api/state')).data.sessions.find((x: any) => x.id === hard.id).workout.hard, false);
  }

  // availability preview: nothing saved, optimal versus limited
  const open = { days: Array.from({ length: 7 }, () => ({ minutes: null, pool: true, gym: true })), fixed: { swim: [0, 2, 4] } };
  const pv = await api('POST', '/api/availability/preview', { availability: open, week: 'peak' });
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.equal(pv.data.limited, false);
  assert.equal(pv.data.days.length, 7);
  assert.deepEqual(pv.data.days.map((d: any, i: number) => (d.sessions.some((x: any) => x.sport === 'swim') ? i : -1)).filter((i: number) => i >= 0), [0, 2, 4]);
  const tight = { ...open, days: open.days.map((d, i) => (i >= 1 && i <= 4 ? { ...d, minutes: 45 } : d)) };
  const pv2 = await api('POST', '/api/availability/preview', { availability: tight, week: 'peak' });
  assert.equal(pv2.data.limited, true);
  assert.ok(pv2.data.minutes < pv2.data.optimal.minutes, 'limits cost training time and the preview says so');
  assert.ok(pv2.data.days.slice(1, 5).every((d: any) => d.minutes <= 55), JSON.stringify(pv2.data.days.map((d: any) => d.minutes))); // swims are sized in whole lengths, so a few minutes over
  const saved = (await api('GET', '/api/state')).data.availability;
  assert.ok(!saved.fixed?.swim, 'preview saved nothing');
  assert.equal((await api('PUT', '/api/availability', { ...tight, overrides: {} })).status, 200);
  const now = (await api('GET', '/api/state')).data;
  assert.deepEqual(now.availability.fixed.swim, [0, 2, 4]);
  assert.equal(now.availability.days[0].minutes, null);
  assert.equal(now.weekStats[now.currentWeek].start, '2026-11-09');
});

test('unlink and link activities over the API; unlinked activities survive a sync and undo restores the link', async () => {
  await api('POST', '/api/plan/generate', { scope: 'week' });
  let { data } = await api('GET', '/api/state');
  let x = data.sessions.find((s: any) => s.actual?.activityId === 'a1');
  if (!x) {
    const bike = data.sessions.find((s: any) => s.sport === 'bike' && s.status === 'planned' && !s.actual && s.date >= '2026-11-09');
    assert.ok(bike, 'a bike session exists to link to');
    assert.equal((await api('POST', '/api/activities/a1/link', { sessionId: bike.id })).status, 200);
    data = (await api('GET', '/api/state')).data;
    x = data.sessions.find((s: any) => s.id === bike.id);
  }
  assert.equal(x.status, 'done');
  assert.equal(x.date, '2026-11-10');
  const id = x.id;

  assert.equal((await api('POST', '/api/sessions/nope/unlink', {})).status, 400);
  const un = await api('POST', `/api/sessions/${id}/unlink`, {});
  assert.equal(un.status, 200, JSON.stringify(un.data));
  data = (await api('GET', '/api/state')).data;
  const after = data.sessions.find((s: any) => s.id === id);
  assert.equal(after.actual, undefined);
  assert.equal(after.status, 'planned');
  assert.ok(data.extras.some((a: any) => a.id === 'a1'), 'the activity is now an unplanned extra');
  assert.match(data.undo.label, /Unlinking/);
  assert.equal((await api('POST', `/api/sessions/${id}/unlink`, {})).status, 400, 'cannot unlink twice');

  // a sync re-reads the activity but must not re-link it
  await api('POST', '/api/intervals/sync', {});
  data = (await api('GET', '/api/state')).data;
  assert.equal(data.sessions.find((s: any) => s.id === id).actual, undefined);
  assert.ok(data.extras.some((a: any) => a.id === 'a1'));

  // linking rules
  const run = data.sessions.find((s: any) => s.sport === 'run' && s.status === 'planned');
  const wrong = await api('POST', '/api/activities/a1/link', { sessionId: run.id });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /same sport/);
  assert.equal((await api('POST', '/api/activities/missing/link', { sessionId: id })).status, 400);
  assert.equal((await api('POST', '/api/activities/a1/link', { sessionId: id })).status, 200);
  data = (await api('GET', '/api/state')).data;
  assert.equal(data.sessions.find((s: any) => s.id === id).actual.activityId, 'a1');
  assert.ok(!data.extras.some((a: any) => a.id === 'a1'));
  // undo the manual link, then undo the unlink: back to the original link
  await api('POST', '/api/undo', {});
  assert.equal((await api('GET', '/api/state')).data.sessions.find((s: any) => s.id === id).actual, undefined);
  await api('POST', '/api/undo', {});
  assert.equal((await api('GET', '/api/state')).data.sessions.find((s: any) => s.id === id).actual?.activityId, 'a1');
});
