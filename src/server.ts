// HTTP server: JSON API + static UI. No dependencies; run with `npm start`.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createAuth, loginPage } from './auth.ts';
import { Store } from './store.ts';
import { addDays, localToday, mondayOf } from './engine/dates.ts';
import { applyReadiness, customWorkout, discardSnapshot, ensureHorizon, generate, linkActivity, previewWeek, recordThresholds, reconcile, sessionSig, snapshot, toIcs, uid, undo, unlinkSession, viewState } from './engine/plan.ts';
import { assessReadiness } from './engine/readiness.ts';
import { aerobicVersion, applyAdaptations, proposeAdaptations, resized } from './engine/adapt.ts';
import { analyzeExecution, applyProgress, plannedReps, progressKey, revertProgress } from './engine/execution.ts';
import { buildLeg } from './engine/course.ts';
import { Intervals, IntervalsError, racesFrom, thresholdsFrom } from './intervals.ts';
import type { Session } from './engine/types.ts';
import { chatView, COACH_MODEL, coachConfigured, CoachError, coachTurn, DEBRIEF_PROMPT } from './coach.ts';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

/** Validate the weekly availability pattern: optional daily limits and the days the athlete has fixed. */
function parseAvailability(b: any) {
  const dayList = (v: any) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : undefined);
  const one = (v: any) => (v === null || v === undefined || v === '' || !Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 6 ? undefined : Number(v));
  const f = b.fixed ?? {};
  const swim = dayList(f.swim), strength = dayList(f.strength);
  return {
    days: b.days.map((d: any) => ({
      minutes: d?.minutes === null || d?.minutes === undefined || d?.minutes === '' ? null : Math.max(0, Math.min(600, Number(d.minutes) || 0)),
      pool: !!d?.pool, gym: !!d?.gym,
    })),
    fixed: { swim: swim?.length ? swim : undefined, strength: strength?.length ? strength : undefined, longRide: one(f.longRide), longRun: one(f.longRun), rest: one(f.rest) },
  };
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function body(req: IncomingMessage, max = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, 'Request too large');
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
  /**
   * Grade one completed session rep by rep from its activity's detected intervals, and move the
   * progression level for its workout type. A re-grade replaces the earlier verdict and takes back
   * whatever progression that one had earned. Custom workouts are graded but have no level to move.
   */
  async function gradeSession(x: Session, api: Intervals): Promise<boolean> {
    const id = x.actual?.activityId;
    if (!id || !plannedReps(x, s().profile).length) return false;
    const exec = analyzeExecution(x, await api.activityIntervals(id), s().profile);
    if (!exec) return false;
    const progress = (s().progress ??= {});
    if (x.actual!.exec) { revertProgress(progress, x.workout.code, x.actual!.exec); s().progressLog = (s().progressLog ?? []).filter((e) => e.id !== id); }
    x.actual!.exec = exec;
    if (x.workout.code !== 'custom') {
      const d = applyProgress(progress, x.workout.code, exec);
      if (d) (s().progressLog ??= []).push({ id, date: x.date, key: progressKey(x.workout.code), delta: d, name: x.workout.name, verdict: exec.verdict });
      if ((s().progressLog?.length ?? 0) > 80) s().progressLog!.splice(0, s().progressLog!.length - 80);
    }
    return true;
  }

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
    recordThresholds(s(), t);
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
    // Grade recently completed key sessions rep by rep; each activity is fetched once.
    let graded = 0;
    // Ungraded sessions are graded; "could not be graded" is retried for a week, since Intervals.icu
    // can take a while to detect the intervals in a fresh activity.
    for (const x of s().sessions) {
      const e = x.actual?.exec;
      if (!x.actual?.activityId || graded >= 12) continue;
      if (e ? !(e.verdict === 'unstructured' && x.date >= addDays(t, -7)) : x.date < addDays(t, -21)) continue;
      try { if (await gradeSession(x, api)) graded++; } catch (err) { if (!(err instanceof IntervalsError)) throw err; }
    }
    // Progress that changed will not show in the plan until it is regenerated; do that for athletes who let the plan adapt itself.
    const progressChanged = JSON.stringify(s().progress ?? {}) !== JSON.stringify(s().progressAtPlan ?? {});
    if (progressChanged && s().profile.autoAdapt && s().season) { snapshot(s(), 'Re-plan after progression changed'); generate(s(), t, 'future'); }
    if (s().profile.autoAdapt) snapshot(s(), 'Automatic adjustments after sync');
    const adapted = s().profile.autoAdapt ? applyAdaptations(s(), t) : [];
    if (s().profile.autoAdapt && !adapted.length) discardSnapshot(s());
    s().intervals.lastSync = new Date().toISOString();
    s().intervals.lastError = undefined;
    return {
      thresholdsUpdated: updated, activities: s().activities.length, added: Math.max(0, s().activities.length - before),
      matched, graded, adapted, importedRaces, historyFrom: s().intervals.historyFrom, hidden: s().intervals.hidden ?? 0,
    };
  }

  let busy = false;
  /** One coach turn with an undo point: kept only if the coach actually changed the plan. */
  async function runCoach(message: string, onText?: (t: string) => void) {
    snapshot(s(), 'Changes made by the coach');
    try {
      const r = await coachTurn(s(), today(), message, onText);
      if (!r.changes.length) discardSnapshot(s());
      return r;
    } catch (e) { discardSnapshot(s()); throw e; }
  }
  const routes: Record<string, (req: IncomingMessage, id?: string) => Promise<unknown>> = {
    'GET /api/state': async () => {
      if (ensureHorizon(s(), today())) store.save();
      return { ...viewState(s(), today()), auth: { enabled: auth.enabled }, coach: { configured: coachConfigured(s()), model: COACH_MODEL, messages: chatView(s()) } };
    },

    'POST /api/coach': async (req) => {
      const b = await body(req);
      const message = String(b.message ?? '').trim().slice(0, 8000);
      if (!message) throw new HttpError(400, 'Message is empty');
      if (busy) throw new HttpError(409, 'The coach is still answering your previous message.');
      busy = true;
      try { return { ok: true, ...(await runCoach(message)) }; } finally { busy = false; }
    },
    'DELETE /api/coach': async () => { s().coach.messages = []; return { ok: true }; },
    // A written review of the week just finished, produced by the coach on request.
    'POST /api/coach/debrief': async () => {
      if (busy) throw new HttpError(409, 'The coach is still answering your previous message.');
      busy = true;
      try {
        const t = today();
        const r = await coachTurn(s(), t, DEBRIEF_PROMPT);
        s().debrief = { week: mondayOf(t), text: r.reply, at: new Date().toISOString() };
        return { ok: true, ...r };
      } finally { busy = false; }
    },
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
        ramp: pickOf(b.ramp, ['conservative', 'moderate', 'aggressive', 'learned'], p.ramp),
        recoveryCycle: pickOf(b.recoveryCycle, ['auto', '3:1', '2:1'], p.recoveryCycle),
        restDay: b.restDay === undefined ? p.restDay : !!b.restDay,
        comeback: {
          active: !!(b.comeback?.active ?? p.comeback.active),
          weeksOff: Math.max(0, Math.min(104, Number(b.comeback?.weeksOff ?? p.comeback.weeksOff) || 0)),
          resumedOn: isDate(b.comeback?.resumedOn) ? b.comeback.resumedOn : undefined,
          note: b.comeback?.note ? String(b.comeback.note).slice(0, 500) : undefined,
          // The block keeps its start date unless the athlete changes what defines it.
          planStart: p.comeback.active && !!(b.comeback?.active ?? p.comeback.active) && Number(b.comeback?.weeksOff ?? p.comeback.weeksOff) === p.comeback.weeksOff && !isDate(b.comeback?.resumedOn) ? p.comeback.planStart : undefined,
        },
        strengthEquipment: pickOf(b.strengthEquipment, ['gym', 'home'], p.strengthEquipment),
        autoThresholds: b.autoThresholds === undefined ? p.autoThresholds : !!b.autoThresholds,
        autoAdapt: b.autoAdapt === undefined ? p.autoAdapt : !!b.autoAdapt,
        recovery: { rhr: pickOf(b.recovery?.rhr, ['auto', 'resting', 'sleeping'], p.recovery?.rhr ?? 'auto'), hrv: pickOf(b.recovery?.hrv, ['auto', 'rmssd', 'sdnn'], p.recovery?.hrv ?? 'auto') },
      };
      recordThresholds(s(), today());
      return { ok: true };
    },

    'PUT /api/availability': async (req) => {
      const b = await body(req);
      if (!Array.isArray(b.days) || b.days.length !== 7) throw new HttpError(400, 'Expected 7 days');
      const overrides: Record<string, { minutes: number; note?: string }> = {};
      for (const [k, v] of Object.entries<any>(b.overrides ?? {})) {
        if (isDate(k)) overrides[k] = { minutes: Math.max(0, Math.min(600, Number(v?.minutes) || 0)), note: v?.note ? String(v.note).slice(0, 80) : undefined };
      }
      s().availability = { ...parseAvailability(b), overrides };
      return { ok: true };
    },
    // What the plan would lay out under a draft availability; saves nothing.
    'POST /api/availability/preview': async (req) => {
      const b = await body(req);
      if (!Array.isArray(b.availability?.days) || b.availability.days.length !== 7) throw new HttpError(400, 'Expected 7 days');
      return previewWeek(s(), today(), { ...parseAvailability(b.availability), overrides: {} }, b.week === 'peak' ? 'peak' : 'next');
    },
    'POST /api/undo': async () => {
      const label = undo(s());
      if (!label) throw new HttpError(400, 'Nothing to undo');
      return { ok: true, label };
    },

    'PUT /api/races': async (req) => {
      const b = await body(req);
      if (!Array.isArray(b)) throw new HttpError(400, 'Expected a list');
      const types = ['sprint', 'olympic', 'half', 'full', 'duathlonSprint', 'duathlon', 'aquathlon', 'run10k', 'halfMarathon', 'marathon', 'bikeEvent', 'other'];
      const seen = new Set<string>();
      for (const r of b) {
        const k = `${String(r?.name ?? '').trim().toLowerCase()}|${r?.date}`;
        if (seen.has(k)) throw new HttpError(400, `“${r.name}” on ${r.date} is listed twice. Remove the duplicate.`);
        seen.add(k);
      }
      const prev = new Map(s().races.map((r) => [r.id, r]));
      s().races = b.filter((r: any) => isDate(r?.date) && r?.name).slice(0, 40).map((r: any) => ({
        // Course and target splits are edited separately and must survive a save of the list.
        course: prev.get(r.id)?.course, podium: prev.get(r.id)?.podium, result: prev.get(r.id)?.result,
        id: r.id || uid('r'), name: String(r.name).slice(0, 80), date: r.date,
        type: types.includes(r.type) ? r.type : 'olympic', priority: ['A', 'B', 'C'].includes(r.priority) ? r.priority : 'B',
        goal: r.goal ? String(r.goal).slice(0, 200) : undefined, notes: r.notes ? String(r.notes).slice(0, 500) : undefined,
      }));
      return { ok: true };
    },

    // Course (GPX tracks parsed in the browser, sent as [lat, lon, ele] points), conditions and target splits.
    'PUT /api/races/:id': async (req, id) => {
      const b = await body(req, 4_000_000);
      const race = s().races.find((r) => r.id === id);
      if (!race) throw new HttpError(404, 'Race not found');
      const c = { ...(race.course ?? {}) };
      const num = (v: any, lo: number, hi: number) => (v === null || v === '' || v === undefined || !Number.isFinite(Number(v)) ? undefined : Math.max(lo, Math.min(hi, Number(v))));
      const track = (pts: any) => {
        if (!Array.isArray(pts) || pts.length < 2 || pts.length > 20000) throw new HttpError(400, 'The GPX track could not be read.');
        try { return buildLeg(pts.map((q: any) => [Number(q[0]), Number(q[1]), Number(q[2])])); } catch (e: any) { throw new HttpError(400, e.message); }
      };
      if (b.bikePoints) c.bike = track(b.bikePoints);
      if (b.runPoints) c.run = track(b.runPoints);
      if (b.clearBike) delete c.bike;
      if (b.clearRun) delete c.run;
      if ('cda' in b) c.cda = num(b.cda, 0.15, 0.5);
      if ('bikeKg' in b) c.bikeKg = num(b.bikeKg, 5, 20);
      if ('tempC' in b) c.tempC = num(b.tempC, -5, 45);
      if ('transitionMin' in b) c.transitionMin = num(b.transitionMin, 0, 30);
      if ('wetsuit' in b) c.wetsuit = !!b.wetsuit;
      race.course = Object.values(c).some((v) => v !== undefined && v !== false) ? c : undefined;
      if (b.result) {
        const manual: Record<string, number> = {};
        for (const [k, v] of Object.entries<any>(b.result.manual ?? {})) {
          const n = num(v, 30, 172800);
          if (n && ['Swim', 'Bike', 'Run', 'Run 1', 'Run 2', 'Total'].includes(k)) manual[k] = n;
        }
        const then = { ftp: num(b.result.then?.ftp, 80, 600), runPaceSecPerKm: num(b.result.then?.runPaceSecPerKm, 150, 480), cssSecPer100: num(b.result.then?.cssSecPer100, 55, 200) };
        race.result = { manual: Object.keys(manual).length ? manual : undefined, then: Object.values(then).some((v) => v !== undefined) ? then : undefined, use: b.result.use !== false };
      }
      if (b.podium) {
        const p = { swim: num(b.podium.swim, 60, 86400), bike: num(b.podium.bike, 60, 86400), run: num(b.podium.run, 60, 86400), total: num(b.podium.total, 60, 172800) };
        race.podium = Object.values(p).some((v) => v !== undefined) ? p : undefined;
      }
      return { ok: true };
    },

    'POST /api/niggles': async (req) => {
      const b = await body(req);
      const area = String(b.area ?? '').trim().slice(0, 40);
      if (!area) throw new HttpError(400, 'Say where it is');
      (s().niggles ??= []).push({
        id: uid('n'), date: today(), area, sport: ['run', 'bike', 'swim'].includes(b.sport) ? b.sport : 'run',
        severity: [1, 2, 3].includes(Number(b.severity)) ? Number(b.severity) as 1 | 2 | 3 : 1, note: b.note ? String(b.note).slice(0, 200) : undefined,
      });
      return { ok: true };
    },
    'PATCH /api/niggles/:id': async (req, id) => {
      const b = await body(req);
      const n = (s().niggles ?? []).find((x) => x.id === id);
      if (!n) throw new HttpError(404, 'Not found');
      if ([1, 2, 3].includes(Number(b.severity))) n.severity = Number(b.severity) as 1 | 2 | 3;
      if (b.resolved) n.resolved = today();
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
      if (s().season) snapshot(s(), b.scope === 'week' ? 'Re-plan from today' : 'Re-plan of future weeks');
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
      snapshot(s(), `Adding “${workout.name}”`);
      const session: Session = { id: uid('s'), date: b.date, sport: workout.sport, role: workout.hard ? 'key' : 'easy', workout, status: 'planned', locked: true, origin: 'custom' };
      s().sessions.push(session);
      s().sessions.sort((a, c) => a.date.localeCompare(c.date));
      return { ok: true, id: session.id };
    },
    'PATCH /api/sessions/:id': async (req, id) => {
      const b = await body(req);
      const x = s().sessions.find((q) => q.id === id);
      if (!x) throw new HttpError(404, 'Session not found');
      if (b.date !== undefined && !isDate(b.date)) throw new HttpError(400, 'Invalid date');
      if (b.locked === undefined || Object.keys(b).length > 1) snapshot(s(), `Change to “${x.workout.name}”`);
      if (b.date !== undefined) { x.date = b.date; x.locked = true; }
      // Quick edits: resize an aerobic session, or swap a hard one for its easy equivalent.
      if (b.minutes !== undefined || b.easy) {
        const wk = s().season?.weeks.find((w) => x.date >= w.start && x.date <= addDays(w.start, 6)) ?? s().season?.weeks[0];
        const w = b.easy ? aerobicVersion(x, s().profile) : wk ? resized(x, Math.max(15, Math.min(480, Math.round(Number(b.minutes) / 5) * 5)), wk, s().profile) : null;
        if (!w) { discardSnapshot(s()); throw new HttpError(400, b.easy ? 'This session has no easy version.' : 'Interval sessions cannot be resized here — ask the coach, or replace it from your library.'); }
        const before = x.workout.name;
        x.workout = w; x.locked = true; x.origin = 'adapted';
        if (b.easy) x.role = 'easy';
        x.adaptedNote = b.easy ? `Made easy by you (was “${before}”).` : `Resized by you to ${w.durationMin} min.`;
      }
      if (['planned', 'done', 'skipped'].includes(b.status)) { x.status = b.status; x.locked = b.status !== 'planned' || x.locked; }
      if (b.locked !== undefined) x.locked = !!b.locked;
      s().sessions.sort((a, c) => a.date.localeCompare(c.date));
      return { ok: true };
    },
    // Detach a completed activity from its session so the session can be moved, changed or skipped.
    'POST /api/sessions/:id/unlink': async (_req, id) => {
      const x = s().sessions.find((q) => q.id === id);
      if (!x?.actual?.activityId) throw new HttpError(400, 'This session is not linked to an activity.');
      snapshot(s(), `Unlinking “${x.actual.name ?? 'activity'}” from “${x.workout.name}”`);
      return { ok: true, ...unlinkSession(s(), id as string) };
    },
    // Link an unplanned (or wrongly linked) activity to the session it really was.
    'POST /api/activities/:id/link': async (req, id) => {
      const b = await body(req);
      const a = s().activities.find((q) => q.id === id);
      snapshot(s(), `Linking “${a?.name ?? 'activity'}” to a session`);
      let linked: { name: string };
      try { linked = linkActivity(s(), String(id), String(b.sessionId ?? '')); }
      catch (e: any) { discardSnapshot(s()); throw new HttpError(400, e.message); }
      // Grade it straight away: the evaluation against the plan should be there the moment it is linked.
      const x = s().sessions.find((q) => q.id === b.sessionId)!;
      let graded = false, gradeError: string | undefined;
      if (s().intervals.apiKey && plannedReps(x, s().profile).length) {
        try { graded = await gradeSession(x, client()); } catch (e: any) { gradeError = e instanceof IntervalsError ? e.message : 'Could not fetch the activity’s intervals.'; }
      }
      return { ok: true, ...linked, graded, gradeError, verdict: x.actual?.exec?.verdict };
    },
    // Grade (or re-grade) a linked session against its activity's intervals.
    'POST /api/sessions/:id/regrade': async (_req, id) => {
      const x = s().sessions.find((q) => q.id === id);
      if (!x?.actual?.activityId) throw new HttpError(400, 'This session is not linked to an activity.');
      if (!plannedReps(x, s().profile).length) throw new HttpError(400, 'This session has no interval targets to grade against.');
      snapshot(s(), `Re-grading “${x.workout.name}”`);
      try { await gradeSession(x, client()); } catch (e) { discardSnapshot(s()); throw e; }
      return { ok: true, verdict: x.actual.exec?.verdict ?? null };
    },
    'DELETE /api/sessions/:id': async (_req, id) => {
      const gone = s().sessions.find((q) => q.id === id);
      if (gone) snapshot(s(), `Deleting “${gone.workout.name}”`);
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
      snapshot(s(), 'Readiness adjustment');
      const changes = applyReadiness(s(), t, assessReadiness(t, s().wellness, s().checkins[t], s().profile.recovery));
      if (!changes.length) discardSnapshot(s());
      return { ok: true, changes };
    },

    'POST /api/adapt/apply': async () => {
      snapshot(s(), 'Suggested adjustments');
      const changes = applyAdaptations(s(), today());
      if (!changes.length) discardSnapshot(s());
      return { ok: true, changes };
    },
    'POST /api/adapt/dismiss': async (req) => {
      const key = String((await body(req)).key ?? '');
      if (proposeAdaptations(s(), today()).some((a) => a.key === key)) (s().dismissedAdapt ??= []).push(key);
      return { ok: true };
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
      // Remember exactly what the devices now hold, so later edits can be flagged as not yet sent.
      s().intervals.pushed = Object.fromEntries(s().sessions.filter((x) => r.ids.includes(x.id)).map((x) => [x.id, sessionSig(x, s().profile)]));
      return { ok: true, pushed: r.pushed, removed: r.removed };
    },
    'DELETE /api/intervals': async () => { s().intervals = {}; return { ok: true }; },
  };

  const auth = createAuth(opts.password);

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, data: unknown, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(data) : (data as string | Buffer));
    };
    // ---- sign-in (only when a password is set) ----
    if (auth.enabled && (url.pathname === '/login' || url.pathname === '/logout')) {
      const page = (status: number, error?: string) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' }); res.end(loginPage(error)); };
      if (url.pathname === '/logout' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': auth.clearCookie(req), 'Cache-Control': 'no-store' });
        return res.end('{"ok":true}');
      }
      if (url.pathname === '/login' && req.method === 'GET') {
        if (auth.check(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
        return page(200);
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        const wait = auth.lockedFor(req);
        if (wait) return page(429, `Too many failed attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 10_000) break; }
        if (auth.passwordOk(new URLSearchParams(raw).get('password') ?? '')) {
          res.writeHead(303, { Location: '/', 'Set-Cookie': auth.setCookie(req), 'Cache-Control': 'no-store' });
          return res.end();
        }
        auth.fail(req);
        await new Promise((r) => setTimeout(r, 400)); // slow down guessing
        return page(401, 'Wrong password.');
      }
      res.writeHead(405); return res.end();
    }
    if (!auth.check(req)) {
      // API calls get a plain 401 (no browser pop-up); page loads go to the sign-in page.
      if (url.pathname.startsWith('/api/') || req.method !== 'GET') { res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"error":"Sign in required"}'); }
      res.writeHead(302, { Location: '/login' }); return res.end();
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        // Same-origin only: state-changing requests must be JSON from our own pages.
        if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
        if (req.method === 'GET' && url.pathname === '/api/history') return send(200, await routes['GET /api/history'](req));
        // Streaming coach reply: server-sent events carrying text as it is written, then the result.
        if (req.method === 'POST' && url.pathname === '/api/coach/stream') {
          const b = await body(req);
          const message = String(b.message ?? '').trim().slice(0, 8000);
          if (!message) throw new HttpError(400, 'Message is empty');
          if (busy) throw new HttpError(409, 'The coach is still answering your previous message.');
          busy = true;
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          const emit = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
          try {
            const r = await runCoach(message, (text) => emit({ type: 'text', text }));
            emit({ type: 'done', ...r });
          } catch (e: any) {
            emit({ type: 'error', error: e instanceof CoachError || e instanceof HttpError ? e.message : 'The coach hit an internal error.' });
            if (!(e instanceof CoachError)) console.error(e);
          } finally { busy = false; store.save(); res.end(); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/plan.ics') return send(200, toIcs(s(), today()), 'text/calendar; charset=utf-8');
        const parts = url.pathname.split('/');
        let key = `${req.method} ${url.pathname}`;
        let id: string | undefined;
        if (!routes[key] && parts.length === 4) { id = decodeURIComponent(parts[3]); key = `${req.method} /api/${parts[2]}/:id`; }
        else if (!routes[key] && parts.length === 5) { id = decodeURIComponent(parts[3]); key = `${req.method} /api/${parts[2]}/:id/${parts[4]}`; }
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
