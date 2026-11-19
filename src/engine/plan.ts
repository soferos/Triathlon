// Orchestration: owns the persisted state shape, (re)generates the plan, reconciles completed
// activities, applies readiness-driven adaptations and builds the payload the UI renders.
import type { Activity, Availability, Checkin, Goal, Niggle, Profile, Race, SeasonWeek, Session, Sport, Wellness, Workout } from './types.ts';
import { courseDemands, gapAnalysis, predictRace } from './course.ts';
import { comebackTracker, learnedRamp } from './insights.ts';
import { analyzeRace, personalModel } from './raceanalysis.ts';
import { revertProgress } from './execution.ts';
import { progressOverview } from './progress.ts';
import { addDays, diffDays, mondayOf } from './dates.ts';
import { buildSeason } from './season.ts';
import { buildWeek } from './week.ts';
import { defaultAvailability, defaultProfile } from './defaults.ts';
import { assessReadiness, HRV_LABEL, monotony, pickSources, RHR_LABEL, type Readiness } from './readiness.ts';
import { finalize, toIcuText, viewWorkout, zoneTable } from './zones.ts';
import { bike, run, swim } from './workouts.ts';
import { strengthProgramme } from './strength.ts';
import { summarizeHistory } from './history.ts';
import { proposeAdaptations } from './adapt.ts';

export const DETAIL_WEEKS = 4;

export interface ThresholdEntry { date: string; ftp?: number; runPower?: number; runPaceSecPerKm?: number; cssSecPer100?: number; bikeLthr?: number; runLthr?: number }
const THRESHOLD_KEYS = ['ftp', 'runPower', 'runPaceSecPerKm', 'cssSecPer100', 'bikeLthr', 'runLthr'] as const;
/** Append the current thresholds to the log if any differ from the last entry. */
export function recordThresholds(s: State, today: string): void {
  const p = s.profile, log = (s.thresholdLog ??= []);
  const cur: ThresholdEntry = { date: today };
  for (const k of THRESHOLD_KEYS) if (p[k]) cur[k] = p[k];
  if (!THRESHOLD_KEYS.some((k) => cur[k])) return;
  const last = log.at(-1);
  if (last && THRESHOLD_KEYS.every((k) => last[k] === cur[k])) return;
  if (last && last.date === today) log[log.length - 1] = cur; else log.push(cur);
  if (log.length > 300) log.shift();
}

export interface State {
  profile: Profile;
  availability: Availability;
  races: Race[];
  goals: Goal[];
  library: { id: string; workout: Workout }[];
  season: { weeks: SeasonWeek[]; warnings: string[]; generatedAt: string } | null;
  sessions: Session[];
  weekWarnings: Record<string, string[]>;
  checkins: Record<string, Checkin>;
  wellness: Wellness[];
  activities: Activity[];
  intervals: {
    apiKey?: string; athleteId?: string; athleteName?: string;
    lastSync?: string; lastPush?: string; lastError?: string;
    /** Oldest date covered by a full history import */
    historyFrom?: string;
    /** Activities that exist in Intervals.icu but are withheld from its API (Strava-sourced) */
    hidden?: number;
    /** What was last sent to Intervals.icu, per session id: "date|signature" */
    pushed?: Record<string, string>;
  };
  coach: { apiKey?: string; messages: unknown[] };
  /** Adaptation proposals the athlete dismissed (cleared when the week rolls over) */
  dismissedAdapt?: string[];
  /** Level offsets per workout type, earned through execution (see execution.ts) */
  progress?: Record<string, number>;
  /** Activities the athlete unlinked from a session: never matched automatically again */
  unlinked?: string[];
  /** Each time grading moved a progression level: which session, which way */
  progressLog?: { id: string; date: string; key: string; delta: number; name: string; verdict: string }[];
  /** Progression levels in force when the plan was last generated, to show what a re-plan would change */
  progressAtPlan?: Record<string, number>;
  /** The plan's own projection per week, recorded the first time it made one: fitness and load */
  planTrace?: Record<string, { ctl: number; tss: number; hours: number }>;
  /** Thresholds over time, appended whenever one changes */
  thresholdLog?: ThresholdEntry[];
  niggles?: Niggle[];
  debrief?: { week: string; text: string; at: string };
  /** Snapshots taken before plan-changing actions, newest last, for Undo */
  undo?: { label: string; at: string; sessions: Session[]; overrides: Availability['overrides']; dismissedAdapt: string[]; progress: Record<string, number>; unlinked: string[]; progressLog: NonNullable<State['progressLog']> }[];
}

export const emptyState = (): State => ({
  profile: defaultProfile(), availability: defaultAvailability(), races: [], goals: [], library: [],
  season: null, sessions: [], weekWarnings: {}, checkins: {}, wellness: [], activities: [], intervals: {}, coach: { messages: [] },
});

export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function currentCtl(s: State): number | undefined {
  const w = [...s.wellness].sort((a, b) => a.date.localeCompare(b.date)).filter((x) => x.ctl != null).at(-1);
  return w?.ctl;
}

/**
 * Regenerate the season and the detailed sessions for the next DETAIL_WEEKS weeks.
 * The past is never rewritten; locked sessions (custom, moved, adapted, completed) always survive.
 *  - 'future': keep the current week if it already has sessions, rebuild the following weeks
 *  - 'week':   also rebuild the rest of the current week from today
 */
export function generate(s: State, today: string, scope: 'future' | 'week' = 'future'): void {
  // Keep the athlete's own sustainable ramp current; it is only used when they opt in ('learned').
  s.profile.learnedRamp = learnedRamp(s.wellness)?.suggested;
  // The rebuild block counts from the Monday this plan first started it, so it ends instead of restarting every week.
  if (s.profile.comeback.active && !s.profile.comeback.resumedOn && !s.profile.comeback.planStart) s.profile.comeback.planStart = mondayOf(today);
  recordThresholds(s, today);
  const season = buildSeason({ today, profile: s.profile, availability: s.availability, races: s.races, ctl: currentCtl(s) });
  // Attach what the target course demands, and how far out the race is, to each week.
  const model = personalModel(s.races, s.activities, s.profile, today);
  const demands = new Map(s.races.map((r) => [r.id, courseDemands(r, s.profile, model)]));
  // Remember what the plan assumed for each week the first time it did, so reality can be compared with it later.
  const trace = (s.planTrace ??= {});
  for (const w of season.weeks) if (!(w.start in trace)) trace[w.start] = { ctl: w.ctlEnd, tss: w.targetTss, hours: w.targetHours };
  s.progressAtPlan = { ...(s.progress ?? {}) };
  for (const w of season.weeks) {
    const race = s.races.find((r) => r.id === w.targetRaceId);
    if (!race || race.date < w.start) continue;
    w.course = demands.get(race.id);
    w.weeksOut = Math.floor(diffDays(mondayOf(race.date), w.start) / 7);
  }
  s.season = { ...season, generatedAt: new Date().toISOString() };
  const weekStart = mondayOf(today);
  for (let i = 0; i < Math.min(DETAIL_WEEKS, season.weeks.length); i++) {
    const wk = season.weeks[i];
    const end = addDays(wk.start, 6);
    const inWeek = (x: Session) => x.date >= wk.start && x.date <= end;
    const existing = s.sessions.filter(inWeek);
    if (wk.start === weekStart && scope === 'future' && existing.length) continue;
    const keep = existing.filter((x) => x.locked || x.status !== 'planned' || x.date < today);
    const built = buildWeek(wk, s.profile, s.availability, s.progress ?? {});
    const fresh = built.sessions.filter((n) => {
      if (n.date < today) return false;
      if (keep.some((k) => k.date === n.date && k.sport === n.sport)) return false;
      // Don't schedule a second long/key/test session of a sport that was already done or pinned this week.
      if (['long', 'key', 'test'].includes(n.role) && keep.some((k) => k.sport === n.sport && k.role === n.role && k.status !== 'skipped')) return false;
      return true;
    });
    s.sessions = s.sessions.filter((x) => !inWeek(x)).concat(keep, fresh);
    s.weekWarnings[wk.start] = built.warnings;
  }
  for (const k of Object.keys(s.weekWarnings)) if (k < weekStart) delete s.weekWarnings[k];
  s.sessions.sort((a, b) => a.date.localeCompare(b.date));
}

/** Remember the plan as it is now, so the next change can be undone. */
export function snapshot(s: State, label: string): void {
  (s.undo ??= []).push({ label, at: new Date().toISOString(), sessions: structuredClone(s.sessions), overrides: structuredClone(s.availability.overrides), dismissedAdapt: [...(s.dismissedAdapt ?? [])], progress: { ...(s.progress ?? {}) }, unlinked: [...(s.unlinked ?? [])], progressLog: structuredClone(s.progressLog ?? []) });
  if (s.undo.length > 10) s.undo.shift();
}
/** Drop the newest snapshot when the action it guarded changed nothing. */
export function discardSnapshot(s: State): void { s.undo?.pop(); }
export function undo(s: State): string | null {
  const snap = s.undo?.pop();
  if (!snap) return null;
  s.sessions = snap.sessions;
  s.availability.overrides = snap.overrides;
  s.dismissedAdapt = snap.dismissedAdapt;
  s.progress = snap.progress;
  s.unlinked = snap.unlinked;
  s.progressLog = snap.progressLog;
  return snap.label;
}

/** A session's identity as far as a device is concerned: when it is and what it contains. */
export function sessionSig(x: Session, p: Profile): string {
  const text = `${x.workout.name}\n${toIcuText(finalize(x.workout, p), p)}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${x.date}|${h}`;
}
/** Planned sessions in the next two weeks that differ from what was last pushed to Intervals.icu. */
export function unsynced(s: State, today: string): { changed: number; removed: number; never: boolean } {
  const pushed = s.intervals.pushed ?? {};
  const to = addDays(today, 13);
  const live = s.sessions.filter((x) => x.date >= today && x.date <= to && x.status === 'planned' && x.sport !== 'race');
  const ids = new Set(live.map((x) => x.id));
  return {
    changed: live.filter((x) => pushed[x.id] !== sessionSig(x, s.profile)).length,
    removed: Object.entries(pushed).filter(([id, sig]) => !ids.has(id) && sig.slice(0, 10) >= today && sig.slice(0, 10) <= to).length,
    never: !s.intervals.lastPush,
  };
}

/**
 * The week the plan would lay out under a given availability, without saving anything — and the
 * same week with every daily limit removed, so the cost of each constraint is visible.
 */
export function previewWeek(s: State, today: string, availability: Availability, which: 'next' | 'peak') {
  const build = (a: Availability) => {
    const season = buildSeason({ today, profile: s.profile, availability: a, races: s.races, ctl: currentCtl(s) });
    const loading = season.weeks.filter((w) => !w.recovery && ['rebuild', 'base', 'build', 'specific'].includes(w.phase));
    const wk = (which === 'peak' ? [...loading].sort((x, y) => y.targetTss - x.targetTss)[0] : loading[0]) ?? season.weeks[0];
    const built = buildWeek(wk, s.profile, a, s.progress ?? {});
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(wk.start, i);
      const list = built.sessions.filter((x) => x.date === date);
      return { date, limit: a.overrides[date]?.minutes ?? a.days[i].minutes, minutes: list.reduce((t, x) => t + x.workout.durationMin, 0),
        sessions: list.map((x) => ({ sport: x.sport, role: x.role, name: x.workout.name, minutes: x.workout.durationMin, tss: x.workout.tss, hard: x.workout.hard })) };
    });
    return { week: { start: wk.start, phase: wk.phase, targetHours: wk.targetHours, targetTss: wk.targetTss }, days, warnings: built.warnings,
      minutes: days.reduce((t, d) => t + d.minutes, 0), tss: built.sessions.reduce((t, x) => t + x.workout.tss, 0), sessions: built.sessions.length };
  };
  const mine = build(availability);
  const limited = availability.days.some((d) => d.minutes != null);
  const optimal = limited ? build({ ...availability, days: availability.days.map((d) => ({ ...d, minutes: null })), overrides: {} }) : mine;
  return { ...mine, limited, optimal: { minutes: optimal.minutes, tss: optimal.tss, sessions: optimal.sessions, days: optimal.days.map((d) => d.minutes) } };
}

/** Roll the plan forward automatically when a new week starts. */
export function ensureHorizon(s: State, today: string): boolean {
  if (!s.season) return false;
  if (s.season.weeks[0]?.start === mondayOf(today)) return false;
  s.dismissedAdapt = [];
  generate(s, today, 'future');
  return true;
}

/**
 * Link completed activities to planned sessions and record what was actually done.
 * An activity pairs with the best-fitting open session of the same sport: one on the same day, or
 * one within two days in the same week and of broadly similar length. In the second case the
 * session was done on a different day than planned, so it moves to the day it happened.
 * Activities that match nothing stay unplanned extras (see unplannedActivities).
 */
export function reconcile(s: State): number {
  let n = 0;
  const byId = new Map(s.activities.map((a) => [a.id, a]));
  const used = new Set<string>();
  const record = (x: Session, a: Activity) => {
    x.actual = {
      tss: a.tss, durationMin: a.durationMin, activityId: a.id, name: a.name,
      distanceKm: a.distanceKm, np: a.np, avgHr: a.avgHr, intensity: a.intensity, decoupling: a.decoupling,
      plannedDate: x.actual?.plannedDate, exec: x.actual?.exec,
    };
  };
  // Refresh sessions matched on an earlier sync (the activity may have been edited or re-analysed since).
  for (const x of s.sessions) {
    const id = x.actual?.activityId;
    if (!id) continue;
    used.add(id);
    const a = byId.get(id);
    if (a) record(x, a);
  }
  const blocked = new Set(s.unlinked ?? []);
  const open = (x: Session, a: Activity) => x.sport === a.sport && !x.actual && x.status !== 'skipped';
  const link = (x: Session, a: Activity) => {
    if (x.date !== a.date) { const planned = x.date; x.date = a.date; record(x, a); x.actual!.plannedDate = planned; } else record(x, a);
    x.status = 'done'; x.locked = true;
    used.add(a.id); n++;
  };
  // One pass, oldest first. A same-day session always qualifies; a session on another day must be
  // within two days in the same week and of broadly similar length. Day distance is weighted so a
  // same-day match wins unless another session is a much better fit (a 2 h run is the long run
  // planned for tomorrow, not today's 30 min jog).
  for (const a of s.activities) {
    if (used.has(a.id) || a.sport === 'other' || blocked.has(a.id)) continue;
    const cands = s.sessions.filter((x) => {
      if (!open(x, a)) return false;
      if (x.date === a.date) return true;
      if (x.status !== 'planned' || mondayOf(x.date) !== mondayOf(a.date) || Math.abs(diffDays(x.date, a.date)) > 2) return false;
      const ratio = a.durationMin / Math.max(1, x.workout.durationMin);
      return ratio >= 0.5 && ratio <= 2;
    });
    if (!cands.length) continue;
    const cost = (x: Session) => Math.abs(diffDays(x.date, a.date)) * 30 + Math.abs(x.workout.durationMin - a.durationMin);
    link(cands.sort((x, y) => cost(x) - cost(y))[0], a);
  }
  if (n) s.sessions.sort((a, b) => a.date.localeCompare(b.date));
  return n;
}

/**
 * Detach a completed activity from the session it was matched to, so the session is open again
 * (and can be moved, changed or skipped) and the activity stays an unplanned extra. The session
 * returns to the day it was planned for if matching had moved it, and any progression it earned
 * from being graded is taken back. The activity is never matched automatically again.
 */
export function unlinkSession(s: State, id: string): { name: string; restoredDate?: string } {
  const x = s.sessions.find((q) => q.id === id);
  if (!x?.actual?.activityId) throw new Error('This session is not linked to an activity.');
  const a = x.actual;
  if (a.exec) revertProgress((s.progress ??= {}), x.workout.code, a.exec);
  s.progressLog = (s.progressLog ?? []).filter((e) => e.id !== a.activityId);
  (s.unlinked ??= []).includes(a.activityId!) || s.unlinked.push(a.activityId!);
  const restoredDate = a.plannedDate && a.plannedDate !== x.date ? a.plannedDate : undefined;
  if (restoredDate) x.date = restoredDate;
  delete x.actual;
  x.status = 'planned';
  // A session the plan generated goes back to being the plan's to re-plan; one the athlete made or edited stays pinned.
  if (x.origin === 'plan') x.locked = false;
  s.sessions.sort((p, q) => p.date.localeCompare(q.date));
  return { name: x.workout.name, restoredDate };
}

/**
 * Link a recorded activity to a planned session by hand — e.g. the easy ride that was really
 * Tuesday's recovery spin, not the sweet spot it was auto-matched to. Must be the same sport.
 * The session takes the activity's day; an activity already linked elsewhere is moved over.
 */
export function linkActivity(s: State, activityId: string, sessionId: string): { name: string } {
  const a = s.activities.find((q) => q.id === activityId);
  const x = s.sessions.find((q) => q.id === sessionId);
  if (!a) throw new Error('Activity not found. Sync with Intervals.icu and try again.');
  if (!x) throw new Error('Session not found.');
  if (a.sport === 'other' || x.sport !== a.sport) throw new Error('An activity can only be linked to a session of the same sport.');
  if (x.actual && x.actual.activityId !== a.id) throw new Error('That session is already linked to another activity. Unlink it first.');
  const prev = s.sessions.find((q) => q.actual?.activityId === a.id && q !== x);
  if (prev) unlinkSession(s, prev.id);
  s.unlinked = (s.unlinked ?? []).filter((id) => id !== a.id);
  const planned = x.date;
  x.actual = { tss: a.tss, durationMin: a.durationMin, activityId: a.id, name: a.name, distanceKm: a.distanceKm, np: a.np, avgHr: a.avgHr, intensity: a.intensity, decoupling: a.decoupling, plannedDate: planned !== a.date ? planned : undefined };
  x.date = a.date; x.status = 'done'; x.locked = true;
  s.sessions.sort((p, q) => p.date.localeCompare(q.date));
  return { name: x.workout.name };
}

/** Completed activities since `from` that are not linked to any planned session. */
export function unplannedActivities(s: State, from: string): Activity[] {
  const linked = new Set(s.sessions.map((x) => x.actual?.activityId).filter(Boolean));
  return s.activities.filter((a) => a.date >= from && !linked.has(a.id));
}

function easier(x: Session, p: Profile, level: 'adjust' | 'recover'): Workout | null {
  const d = x.workout.durationMin;
  if (x.sport === 'bike') return level === 'recover' ? bike.recovery(Math.min(d, 40), 0, p) : bike.endurance(Math.min(d, 75), 0, p);
  if (x.sport === 'run') return level === 'recover' ? null : run.easy(Math.min(d, 45), -1, p);
  if (x.sport === 'swim') return swim.technique(Math.min(d, level === 'recover' ? 30 : 45), 0, p);
  return level === 'recover' ? null : x.workout;
}

/**
 * Apply today's readiness verdict to today's sessions.
 *  adjust:  swap a hard session with tomorrow's easy session of the same sport when that keeps
 *           hard days apart; otherwise replace it with its aerobic equivalent.
 *  recover: everything becomes recovery or is skipped.
 */
export function applyReadiness(s: State, today: string, r: Readiness): string[] {
  const changes: string[] = [];
  if (r.status !== 'adjust' && r.status !== 'recover') return changes;
  const p = s.profile;
  const on = (d: string) => s.sessions.filter((x) => x.date === d && x.status === 'planned');
  for (const x of on(today)) {
    if (x.sport === 'race') continue;
    const isHard = x.workout.hard || x.role === 'test';
    if (r.status === 'adjust') {
      if (!isHard) continue;
      const tomorrow = addDays(today, 1);
      const swap = on(tomorrow).find((y) => y.sport === x.sport && !y.workout.hard && y.role === 'easy');
      const clash = on(tomorrow).some((y) => y.workout.hard) || on(addDays(today, 2)).some((y) => y.workout.hard || y.sport === 'race');
      if (swap && !clash && x.role !== 'brick') {
        swap.date = today; x.date = tomorrow;
        swap.locked = x.locked = true;
        x.origin = 'adapted'; x.adaptedNote = `Moved from ${today}: readiness was low.`;
        changes.push(`Moved “${x.workout.name}” to tomorrow and brought “${swap.workout.name}” forward.`);
        continue;
      }
    }
    const w = easier(x, p, r.status);
    const before = x.workout.name;
    if (!w) {
      x.status = 'skipped'; x.locked = true; x.origin = 'adapted';
      x.adaptedNote = 'Skipped: recovery day.';
      changes.push(`Skipped “${before}”.`);
    } else if (w !== x.workout) {
      x.workout = w; x.locked = true; x.origin = 'adapted';
      x.adaptedNote = `Replaced “${before}”: readiness ${r.status === 'recover' ? 'called for recovery' : 'was low'}.`;
      changes.push(`Replaced “${before}” with “${w.name}”.`);
    }
  }
  s.sessions.sort((a, b) => a.date.localeCompare(b.date));
  return changes;
}

const isHardStep = (sport: Sport, f: number) => f >= (sport === 'bike' ? 0.88 : sport === 'run' ? 0.9 : 0.97);

/** Validate and normalise a user-built workout. */
export function customWorkout(input: any, p: Profile): Workout {
  const sport: Sport = ['swim', 'bike', 'run', 'strength'].includes(input?.sport) ? input.sport : 'bike';
  const name = String(input?.name || 'Custom workout').slice(0, 80);
  const description = String(input?.description || '').slice(0, 2000);
  if (sport === 'strength') {
    const durationMin = clampNum(input?.durationMin, 10, 180, 45);
    return { sport, code: 'custom', name, category: 'strength', hard: false, blocks: [], exercises: [], description, durationMin, tss: Math.round(durationMin * 0.45), custom: true };
  }
  const blocks = (Array.isArray(input?.blocks) ? input.blocks : []).slice(0, 30).map((b: any, i: number) => ({
    name: String(b?.name || `Block ${i + 1}`).replace(/[^\p{L} -]/gu, '').trim().slice(0, 40) || `Block`,
    repeat: Math.round(clampNum(b?.repeat, 1, 100, 1)),
    steps: (Array.isArray(b?.steps) ? b.steps : []).slice(0, 20).map((st: any) => {
      const kind = ['warmup', 'work', 'recovery', 'cooldown', 'rest'].includes(st?.kind) ? st.kind : 'work';
      const lo = kind === 'rest' ? 0 : clampNum(st?.lo, 0.3, 2.5, 0.7);
      const hi = kind === 'rest' ? 0 : Math.max(lo, clampNum(st?.hi, 0.3, 2.5, lo));
      const base = { kind, lo, hi, ramp: !!st?.ramp, cue: st?.cue ? String(st.cue).slice(0, 60) : undefined };
      return sport === 'swim' && kind !== 'rest' && st?.meters
        ? { ...base, meters: Math.round(clampNum(st.meters, 25, 10000, 100) / 25) * 25 }
        : { ...base, secs: Math.round(clampNum(st?.secs, 5, 6 * 3600, 60)) };
    }),
  })).filter((b: any) => b.steps.length);
  if (!blocks.length) throw new Error('A workout needs at least one step.');
  const hard = blocks.some((b: any) => b.steps.some((st: any) => st.kind === 'work' && isHardStep(sport, st.hi)));
  return finalize({ sport, code: 'custom', name, category: hard ? 'threshold' : 'endurance', hard, blocks, description, durationMin: 0, tss: 0, custom: true }, p);
}
function clampNum(v: any, lo: number, hi: number, dflt: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

const renderWorkout = (w: Workout, p: Profile) => {
  const f = finalize(w, p);
  return { ...f, view: viewWorkout(f, p), icu: toIcuText(f, p) };
};

// History-wide analytics only change when data is synced or the comeback settings change, so they
// are computed once per such change rather than on every page load.
const memo = new Map<string, { key: string; value: unknown }>();
function cached<T>(name: string, key: string, fn: () => T): T {
  const hit = memo.get(name);
  if (hit && hit.key === key) return hit.value as T;
  const value = fn();
  memo.set(name, { key, value });
  return value;
}

/** Everything the UI needs, with absolute targets resolved against current thresholds. */
export function viewState(s: State, today: string) {
  const p = s.profile;
  const dataKey = `${today}|${s.intervals.lastSync}|${s.activities.length}|${s.wellness.length}|${JSON.stringify(p.comeback)}|${s.season?.generatedAt}`;
  const readiness = assessReadiness(today, s.wellness, s.checkins[today], p.recovery);
  const sessions = s.sessions
    .filter((x) => x.date >= addDays(mondayOf(today), -28))
    .map((x) => ({ ...x, workout: renderWorkout(x.workout, p) }));

  // The four weeks just gone (for review) followed by the detailed weeks ahead.
  const thisMonday = mondayOf(today);
  const past = [4, 3, 2, 1].map((n) => addDays(thisMonday, -7 * n)).filter((w) => sessions.some((x) => x.date >= w && x.date <= addDays(w, 6)));
  const ahead = (s.season?.weeks ?? []).slice(0, DETAIL_WEEKS);
  const weekStats = [...past.map((start) => ({ start, past: true as boolean, phase: null as string | null, recovery: false, testWeek: false, targetHours: null as number | null, targetTss: null as number | null, focus: '' })),
    ...ahead.map((w) => ({ start: w.start, past: false, phase: w.phase as string | null, recovery: w.recovery, testWeek: w.testWeek, targetHours: w.targetHours as number | null, targetTss: w.targetTss as number | null, focus: w.focus }))].map((w) => {
    const list = sessions.filter((x) => x.date >= w.start && x.date <= addDays(w.start, 6) && x.status !== 'skipped');
    const acts = s.activities.filter((a) => a.date >= w.start && a.date <= addDays(w.start, 6));
    const bySport: Record<string, number> = {};
    for (const x of list) bySport[x.sport] = (bySport[x.sport] ?? 0) + x.workout.durationMin;
    return {
      ...w,
      plannedTss: list.reduce((t, x) => t + x.workout.tss, 0),
      plannedMin: list.reduce((t, x) => t + x.workout.durationMin, 0),
      doneTss: Math.round(acts.reduce((t, a) => t + a.tss, 0)),
      doneMin: Math.round(acts.reduce((t, a) => t + a.durationMin, 0)),
      keyTotal: list.filter((x) => ['key', 'long', 'test', 'race'].includes(x.role)).length,
      keyDone: list.filter((x) => ['key', 'long', 'test', 'race'].includes(x.role) && x.status === 'done').length,
      bySport,
    };
  });

  const daily: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    daily.push(s.activities.filter((a) => a.date === d).reduce((t, a) => t + a.tss, 0));
  }
  const fitness = s.wellness.filter((w) => w.ctl != null).slice(-120)
    .map((w) => ({ date: w.date, ctl: w.ctl!, atl: w.atl ?? w.ctl! }));

  const needs: string[] = [];
  if (!p.ftp && p.bikeTarget === 'power') needs.push('bike FTP');
  if (p.runTarget === 'power' && !p.runPower) needs.push('run threshold power');
  if (p.runTarget === 'pace' && !p.runPaceSecPerKm) needs.push('run threshold pace');
  if (!p.cssSecPer100) needs.push('swim CSS');

  const model = personalModel(s.races, s.activities, p, today);
  const nextRace = s.races.filter((r) => r.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  return {
    today, profile: p, availability: s.availability, goals: s.goals,
    races: s.races.map((r) => ({
      ...r, past: r.date < today,
      analysis: { prediction: predictRace(r, p, model), gap: gapAnalysis(r, p, model), demands: courseDemands(r, p, model) },
      // Only races already run have a result to analyse.
      result_analysis: r.date < today ? analyzeRace(r, s.activities, p, model) : null,
    })),
    raceModel: model ?? null,
    insights: {
      comeback: cached('comeback', dataKey, () => comebackTracker(p, s.activities, s.wellness, s.season?.weeks ?? [], today)),
      ramp: cached('ramp', dataKey, () => learnedRamp(s.wellness)),
      progress: s.progress ?? {},
    },
    overview: progressOverview(s, today),
    niggles: (s.niggles ?? []).filter((n) => !n.resolved),
    debrief: s.debrief ?? null,
    library: s.library.map((l) => ({ id: l.id, workout: renderWorkout(l.workout, p) })),
    season: s.season, sessions, weekStats, weekWarnings: s.weekWarnings,
    readiness, checkin: s.checkins[today] ?? null,
    // The raw recovery numbers behind the readiness check, newest first, so they can be compared with the watch.
    recovery: (() => {
      const used = pickSources(s.wellness, p.recovery);
      return {
        used: { rhr: RHR_LABEL[used.rhr], hrv: HRV_LABEL[used.hrv] },
        days: [...s.wellness].filter((w) => w.date <= today && (w.restingHR || w.avgSleepingHR || w.hrv || w.hrvSDNN || w.sleepSecs)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10)
          .map((w) => ({ date: w.date, restingHR: w.restingHR ?? null, avgSleepingHR: w.avgSleepingHR ?? null, hrv: w.hrv ?? null, hrvSDNN: w.hrvSDNN ?? null, sleepH: w.sleepSecs ? Math.round(w.sleepSecs / 360) / 10 : null })),
      };
    })(),
    intervals: {
      connected: !!s.intervals.apiKey, athleteId: s.intervals.athleteId, athleteName: s.intervals.athleteName,
      lastSync: s.intervals.lastSync, lastPush: s.intervals.lastPush, lastError: s.intervals.lastError,
      historyFrom: s.intervals.historyFrom, hidden: s.intervals.hidden ?? 0, activityCount: s.activities.length,
    },
    history: cached('history', dataKey, () => summarizeHistory(s.activities, s.wellness, today)),
    fitness, ctl: currentCtl(s) ?? null, monotony: monotony(daily),
    activities: s.activities.filter((a) => a.date >= addDays(today, -28)),
    extras: unplannedActivities(s, addDays(mondayOf(today), -28)),
    currentWeek: past.length,
    unsynced: s.intervals.apiKey ? unsynced(s, today) : null,
    undo: s.undo?.length ? { label: s.undo.at(-1)!.label, at: s.undo.at(-1)!.at, depth: s.undo.length } : null,
    adaptations: proposeAdaptations(s, today).map(({ ops, ...a }) => ({ ...a, actionable: ops.length > 0 })),
    zones: zoneTable(p), strength: strengthProgramme(p), needs,
    nextRace: nextRace ? { ...nextRace, days: diffDays(nextRace.date, today) } : null,
  };
}

/** iCalendar export of planned sessions (all-day events) for any calendar app. */
export function toIcs(s: State, today: string): string {
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//triathlon-coach//EN', 'CALSCALE:GREGORIAN'];
  for (const x of s.sessions.filter((q) => q.date >= today && q.status === 'planned')) {
    const d = x.date.replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${x.id}@triathlon-coach`, `DTSTAMP:${d}T000000Z`, `DTSTART;VALUE=DATE:${d}`,
      `DTEND;VALUE=DATE:${addDays(x.date, 1).replace(/-/g, '')}`,
      `SUMMARY:${esc(`${x.workout.name} (${x.workout.durationMin} min)`)}`,
      `DESCRIPTION:${esc(toIcuText(finalize(x.workout, s.profile), s.profile))}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
