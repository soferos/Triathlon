// HTTP server: JSON API + static UI. No dependencies; run with `npm start`.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Store } from './store.ts';
import { addDays, localToday } from './engine/dates.ts';
import { applyReadiness, customWorkout, ensureHorizon, generate, reconcile, toIcs, uid, viewState } from './engine/plan.ts';
import { assessReadiness } from './engine/readiness.ts';
import { Intervals, IntervalsError, racesFrom, thresholdsFrom } from './intervals.ts';
import type { Session } from './engine/types.ts';
import { chatView, COACH_MODEL, coachConfigured, CoachError, coachTurn } from './coach.ts';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));

export function createApp(opts: { dataDir: string; today?: () => string; password?: string }) {
  const store = new Store(opts.dataDir);
  const s = () => store.state;
  const today = opts.today ?? (() => localToday());
  const client = () => {
    if (!s().intervals.apiKey) throw new HttpError(400, 'Intervals.icu is not connected.');
    return new Intervals(s().intervals.apiKey!, s().intervals.athleteId);
  };

  /**
   * Pull everything from Intervals.icu. The first sync (or `full`) walks back year by year until
   * two consecutive years are empty, so the whole training history is imported; later syncs only
   * refresh the last 60 days and merge.
   */
  async function sync(full = false) {
    const api = client();
    const t = today();
    const athlete = await api.athleteInfo();
    s().intervals.athleteName = athlete?.name ?? [athlete?.firstname, athlete?.lastname].filter(Boolean).join(' ') ?? undefined;
    if (athlete?.id) s().intervals.athleteId = String(athlete.id);
    const updated: string[] = [];
    if (s().profile.autoThresholds) {
      const th = thresholdsFrom(athlete);
      for (const [k, v] of Object.entries(th)) {
        if ((s().profile as any)[k] !== v) { (s().profile as any)[k] = v; updated.push(k); }
      }
    }
    if (!s().profile.name && s().intervals.athleteName) s().profile.name = s().intervals.athleteName!;

    const acts = new Map(full ? [] : s().activities.map((a) => [a.id, a]));
    const well = new Map(full ? [] : s().wellness.map((w) => [w.date, w]));
    const before = acts.size;
    let hidden = 0;
    const pull = async (oldest: string, newest: string) => {
      const a = await api.activities(oldest, newest);
      for (const x of a.list) acts.set(x.id, x);
      const w = await api.wellness(oldest, newest);
      for (const x of w) well.set(x.date, x);
      hidden += a.hidden;
      return a.list.length + a.hidden + w.filter((x) => x.ctl != null && x.ctl > 0.5).length;
    };
    if (full || !s().intervals.historyFrom) {
      let empty = 0, oldest = t;
      for (let y = 0; y < 20 && empty < 2; y++) {
        const newest = addDays(t, -365 * y);
        const from = addDays(newest, -364);
        if ((await pull(from, newest)) > 0) { empty = 0; oldest = from; } else empty++;
      }
      const first = [...acts.values()].reduce((m, a) => (a.date < m ? a.date : m), t);
      s().intervals.historyFrom = first < t ? first : oldest;
      s().intervals.hidden = hidden;
    } else {
      // Only wipe-and-replace the recent window, so activities deleted in Intervals.icu disappear here too.
      const from = addDays(t, -60);
      for (const [id, a] of acts) if (a.date >= from) acts.delete(id);
      await pull(from, t);
    }
    s().activities = [...acts.values()].sort((a, b) => a.date.localeCompare(b.date));
    s().wellness = [...well.values()].sort((a, b) => a.date.localeCompare(b.date));

    let importedRaces = 0;
    for (const r of racesFrom(await api.events(t, addDays(t, 540)))) {
      if (!s().races.some((x) => x.date === r.date)) { s().races.push({ id: uid('r'), ...r }); importedRaces++; }
    }
    const matched = reconcile(s());
    s().intervals.lastSync = new Date().toISOString();
    s().intervals.lastError = undefined;
    return {
      thresholdsUpdated: updated, activities: s().activities.length, added: Math.max(0, s().activities.length - before),
      matched, importedRaces, historyFrom: s().intervals.historyFrom, hidden: s().intervals.hidden ?? 0,
    };
  }

  let busy = false;
  const routes: Record<string, (req: IncomingMessage, id?: string) => Promise<unknown>> = {
    'GET /api/state': async () => {
      if (ensureHorizon(s(), today())) store.save();
      return { ...viewState(s(), today()), coach: { configured: coachConfigured(s()), model: COACH_MODEL, messages: chatView(s()) } };
    },

    'POST /api/coach': async (req) => {
      const b = await body(req);
      const message = String(b.message ?? '').trim().slice(0, 8000);
      if (!message) throw new HttpError(400, 'Message is empty');
      if (busy) throw new HttpError(409, 'The coach is still answering your previous message.');
      busy = true;
      try { return { ok: true, ...(await coachTurn(s(), today(), message)) }; } finally { busy = false; }
    },
    'DELETE /api/coach': async () => { s().coach.messages = []; return { ok: true }; },
    'PUT /api/coach/key': async (req) => {
      const key = String((await body(req)).apiKey ?? '').trim();
      s().coach.apiKey = key || undefined;
      return { ok: true };
    },

    'PUT /api/profile': async (req) => {
      const b = await body(req);
      const p = s().profile;
      const num = (v: any, lo: number, hi: number) => (v === null || v === '' || v === undefined ? undefined : Math.max(lo, Math.min(hi, Number(v))) || undefined);
      const pickOf = <T extends string>(v: any, allowed: T[], d: T) => (allowed.includes(v) ? v : d) as T;
      s().profile = {
        ...p,
        name: String(b.name ?? p.name).slice(0, 80),
        birthYear: num(b.birthYear, 1930, 2015),
        sex: b.sex === 'm' || b.sex === 'f' ? b.sex : undefined,
        weightKg: num(b.weightKg, 35, 150),
        ftp: num(b.ftp, 80, 600), bikeLthr: num(b.bikeLthr, 90, 220),
        runPower: num(b.runPower, 100, 700), runPaceSecPerKm: num(b.runPaceSecPerKm, 150, 480), runLthr: num(b.runLthr, 90, 220),
        cssSecPer100: num(b.cssSecPer100, 55, 200),
        bikeTarget: pickOf(b.bikeTarget, ['power', 'hr'], p.bikeTarget),
        runTarget: pickOf(b.runTarget, ['power', 'pace', 'hr'], p.runTarget),
        maxWeeklyHours: num(b.maxWeeklyHours, 3, 35) ?? p.maxWeeklyHours,
        currentWeeklyHours: Math.max(0, Math.min(35, Number(b.currentWeeklyHours ?? p.currentWeeklyHours) || 0)),
        limiter: pickOf(b.limiter, ['none', 'swim', 'bike', 'run'], p.limiter),
        ramp: pickOf(b.ramp, ['conservative', 'moderate', 'aggressive'], p.ramp),
        recoveryCycle: pickOf(b.recoveryCycle, ['auto', '3:1', '2:1'], p.recoveryCycle),
        restDay: b.restDay === undefined ? p.restDay : !!b.restDay,
        comeback: {
          active: !!(b.comeback?.active ?? p.comeback.active),
          weeksOff: Math.max(0, Math.min(104, Number(b.comeback?.weeksOff ?? p.comeback.weeksOff) || 0)),
          resumedOn: isDate(b.comeback?.resumedOn) ? b.comeback.resumedOn : undefined,
          note: b.comeback?.note ? String(b.comeback.note).slice(0, 500) : undefined,
        },
        strengthEquipment: pickOf(b.strengthEquipment, ['gym', 'home'], p.strengthEquipment),
        autoThresholds: b.autoThresholds === undefined ? p.autoThresholds : !!b.autoThresholds,
      };
      return { ok: true };
    },

    'PUT /api/availability': async (req) => {
      const b = await body(req);
      if (!Array.isArray(b.days) || b.days.length !== 7) throw new HttpError(400, 'Expected 7 days');
      const overrides: Record<string, { minutes: number; note?: string }> = {};
      for (const [k, v] of Object.entries<any>(b.overrides ?? {})) {
        if (isDate(k)) overrides[k] = { minutes: Math.max(0, Math.min(600, Number(v?.minutes) || 0)), note: v?.note ? String(v.note).slice(0, 80) : undefined };
      }
      s().availability = {
        days: b.days.map((d: any) => ({ minutes: Math.max(0, Math.min(600, Number(d?.minutes) || 0)), pool: !!d?.pool, gym: !!d?.gym })),
        overrides,
      };
      return { ok: true };
    },

    'PUT /api/races': async (req) => {
      const b = await body(req);
      if (!Array.isArray(b)) throw new HttpError(400, 'Expected a list');
      const types = ['sprint', 'olympic', 'half', 'full', 'run10k', 'halfMarathon', 'marathon', 'bikeEvent', 'other'];
      s().races = b.filter((r: any) => isDate(r?.date) && r?.name).slice(0, 40).map((r: any) => ({
        id: r.id || uid('r'), name: String(r.name).slice(0, 80), date: r.date,
        type: types.includes(r.type) ? r.type : 'olympic', priority: ['A', 'B', 'C'].includes(r.priority) ? r.priority : 'B',
        goal: r.goal ? String(r.goal).slice(0, 200) : undefined, notes: r.notes ? String(r.notes).slice(0, 500) : undefined,
      }));
      return { ok: true };
    },

    'PUT /api/goals': async (req) => {
      const b = await body(req);
      if (!Array.isArray(b)) throw new HttpError(400, 'Expected a list');
      s().goals = b.filter((g: any) => g?.title).slice(0, 60).map((g: any) => ({
        id: g.id || uid('g'), title: String(g.title).slice(0, 140),
        category: ['performance', 'health', 'skill', 'life'].includes(g.category) ? g.category : 'performance',
        horizon: g.horizon === 'long-term' ? 'long-term' : 'season',
        metric: g.metric ? String(g.metric).slice(0, 80) : undefined, target: g.target ? String(g.target).slice(0, 80) : undefined,
        due: isDate(g.due) ? g.due : undefined, status: ['active', 'achieved', 'parked'].includes(g.status) ? g.status : 'active',
      }));
      return { ok: true };
    },

    'POST /api/plan/generate': async (req) => {
      const b = await body(req);
      generate(s(), today(), b.scope === 'week' ? 'week' : 'future');
      return { ok: true, warnings: s().season?.warnings ?? [] };
    },

    'POST /api/library': async (req) => {
      const b = await body(req);
      const workout = customWorkout(b.workout, s().profile);
      const i = s().library.findIndex((l) => l.id === b.id);
      if (i >= 0) s().library[i].workout = workout;
      else s().library.push({ id: uid('w'), workout });
      return { ok: true };
    },
    'DELETE /api/library/:id': async (_req, id) => {
      s().library = s().library.filter((l) => l.id !== id);
      return { ok: true };
    },

    'POST /api/sessions': async (req) => {
      const b = await body(req);
      if (!isDate(b.date)) throw new HttpError(400, 'Invalid date');
      const lib = b.libraryId ? s().library.find((l) => l.id === b.libraryId) : undefined;
      if (b.libraryId && !lib) throw new HttpError(404, 'Workout not found');
      const workout = lib ? structuredClone(lib.workout) : customWorkout(b.workout, s().profile);
      const session: Session = { id: uid('s'), date: b.date, sport: workout.sport, role: workout.hard ? 'key' : 'easy', workout, status: 'planned', locked: true, origin: 'custom' };
      s().sessions.push(session);
      s().sessions.sort((a, c) => a.date.localeCompare(c.date));
      return { ok: true, id: session.id };
    },
    'PATCH /api/sessions/:id': async (req, id) => {
      const b = await body(req);
      const x = s().sessions.find((q) => q.id === id);
      if (!x) throw new HttpError(404, 'Session not found');
      if (b.date !== undefined) {
        if (!isDate(b.date)) throw new HttpError(400, 'Invalid date');
        x.date = b.date; x.locked = true;
      }
      if (['planned', 'done', 'skipped'].includes(b.status)) { x.status = b.status; x.locked = b.status !== 'planned' || x.locked; }
      if (b.locked !== undefined) x.locked = !!b.locked;
      s().sessions.sort((a, c) => a.date.localeCompare(c.date));
      return { ok: true };
    },
    'DELETE /api/sessions/:id': async (_req, id) => {
      s().sessions = s().sessions.filter((q) => q.id !== id);
      return { ok: true };
    },

    'POST /api/checkin': async (req) => {
      const b = await body(req);
      const t = today();
      const lvl = (v: any) => (v ? Math.max(1, Math.min(5, Math.round(Number(v)))) || undefined : undefined);
      s().checkins[t] = {
        date: t, fatigue: lvl(b.fatigue), soreness: lvl(b.soreness), stress: lvl(b.stress),
        sleepHours: b.sleepHours ? Math.max(0, Math.min(14, Number(b.sleepHours))) : undefined,
        symptoms: !!b.symptoms, note: b.note ? String(b.note).slice(0, 300) : undefined,
      };
      for (const k of Object.keys(s().checkins)) if (k < addDays(t, -90)) delete s().checkins[k];
      return { ok: true };
    },
    'POST /api/readiness/apply': async () => {
      const t = today();
      const changes = applyReadiness(s(), t, assessReadiness(t, s().wellness, s().checkins[t]));
      return { ok: true, changes };
    },

    'POST /api/intervals/connect': async (req) => {
      const b = await body(req);
      const apiKey = String(b.apiKey ?? '').trim();
      if (!apiKey) throw new HttpError(400, 'API key is required');
      const prev = { ...s().intervals };
      s().intervals = { apiKey, athleteId: b.athleteId ? String(b.athleteId).trim() : undefined };
      try { return { ok: true, ...(await sync(true)) }; } catch (e) { s().intervals = prev; throw e; }
    },
    'POST /api/intervals/sync': async (req) => ({ ok: true, ...(await sync(!!(await body(req)).full)) }),
    'GET /api/history': async (req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const sport = q.get('sport');
      const all = s().activities.filter((a) => !sport || a.sport === sport);
      const offset = Math.max(0, Number(q.get('offset')) || 0);
      const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 50));
      return { total: all.length, items: all.slice().reverse().slice(offset, offset + limit) };
    },
    'POST /api/intervals/push': async (req) => {
      const b = await body(req);
      const days = Math.max(1, Math.min(28, Number(b.days) || 14));
      const t = today();
      const r = await client().pushSessions(s().sessions, s().profile, t, addDays(t, days - 1));
      s().intervals.lastPush = new Date().toISOString();
      return { ok: true, ...r };
    },
    'DELETE /api/intervals': async () => { s().intervals = {}; return { ok: true }; },
  };

  const auth = (req: IncomingMessage) => {
    if (!opts.password) return true;
    const h = req.headers.authorization ?? '';
    const given = Buffer.from(h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '');
    const want = Buffer.from(opts.password);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, data: unknown, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(data) : (data as string | Buffer));
    };
    if (!auth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Triathlon coach"' });
      return res.end('Authentication required');
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        // Same-origin only: state-changing requests must be JSON from our own pages.
        if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
        if (req.method === 'GET' && url.pathname === '/api/history') return send(200, await routes['GET /api/history'](req));
        if (req.method === 'GET' && url.pathname === '/api/plan.ics') return send(200, toIcs(s(), today()), 'text/calendar; charset=utf-8');
        const parts = url.pathname.split('/');
        let key = `${req.method} ${url.pathname}`;
        let id: string | undefined;
        if (!routes[key] && parts.length === 4) { id = decodeURIComponent(parts[3]); key = `${req.method} /api/${parts[2]}/:id`; }
        const route = routes[key];
        if (!route) throw new HttpError(404, 'Not found');
        const out = await route(req, id);
        if (req.method !== 'GET') store.save();
        return send(200, out);
      }
      const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC)) throw new HttpError(403, 'Forbidden');
      const data = await readFile(file).catch(() => null);
      if (!data) throw new HttpError(404, 'Not found');
      return send(200, data, MIME[extname(file)] ?? 'application/octet-stream');
    } catch (e: any) {
      if (e instanceof IntervalsError) {
        s().intervals.lastError = e.message;
        return send(502, { error: e.message });
      }
      if (e instanceof CoachError) { store.save(); return send(e.status, { error: e.message }); }
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      if (e instanceof Error && e.message.startsWith('A workout needs')) return send(400, { error: e.message });
      console.error(e);
      return send(500, { error: 'Internal error' });
    }
  }
  return { server: createServer(handle), store };
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const password = process.env.APP_PASSWORD || undefined;
  if (host !== '127.0.0.1' && host !== 'localhost' && !password) {
    console.error('Refusing to listen on a non-local address without APP_PASSWORD set.');
    process.exit(1);
  }
  const { server } = createApp({ dataDir: process.env.DATA_DIR || join(ROOT, 'data'), password });
  server.listen(port, host, () => console.log(`Triathlon coach running at http://${host}:${port}`));
}
