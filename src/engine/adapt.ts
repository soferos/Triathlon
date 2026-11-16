// Adaptive layer: compares what was actually done this week with the plan and proposes changes to
// the sessions still to come. Three rules, in priority order:
//   1. Big day    — yesterday/today went well beyond plan: protect the next hard session.
//   2. Overload   — done + remaining would overshoot the week's target: trim easy volume first,
//                   and only then soften one hard session.
//   3. Missed key — a key or long session was not done: reschedule it only if a day has room and
//                   hard-day spacing holds. Missed load is never crammed back in.
// Proposals are pure data; nothing changes until applyAdaptations runs.
import type { Activity, Profile, SeasonWeek, Session, Workout } from './types.ts';
import { addDays, DAY_NAMES, diffDays, dow, mondayOf } from './dates.ts';
import { bike, run, swim } from './workouts.ts';
import type { State } from './plan.ts';
import { dayCap } from './defaults.ts';

type Op =
  | { type: 'scale'; id: string; minutes: number }
  | { type: 'easy'; id: string }
  | { type: 'move'; id: string; date: string }
  | { type: 'cross'; id: string }
  | { type: 'skip'; id: string };

export interface Adaptation {
  /** Stable for the same situation, so a dismissal sticks until the situation changes */
  key: string;
  kind: 'bigday' | 'overload' | 'missed' | 'niggle';
  title: string;
  detail: string;
  /** Human-readable list of what Apply will do */
  actions: string[];
  ops: Op[];
}

const day = (iso: string) => `${DAY_NAMES[dow(iso)]}`;
const hm = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
const r5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);

/** Rebuild an aerobic session at a new duration; null when the workout type cannot be resized. */
export function resized(x: Session, minutes: number, wk: SeasonWeek, p: Profile): Workout | null {
  switch (x.workout.code) {
    case 'bike.endurance': return bike.endurance(minutes, 0, p);
    case 'bike.recovery': return bike.recovery(minutes, 0, p);
    case 'bike.long': return bike.long(minutes, wk.loadIdx, p, wk.recovery ? 'rebuild' : wk.phase, wk.targetType);
    case 'run.easy': return run.easy(minutes, 0, p);
    case 'run.recovery': return run.recovery(minutes, 0, p);
    case 'run.long': return run.long(minutes, wk.loadIdx, p, wk.recovery ? 'rebuild' : wk.phase, wk.targetType);
    case 'swim.technique': return swim.technique(minutes, 0, p);
    case 'swim.endurance': return swim.endurance(minutes, wk.loadIdx, p, wk.recovery ? 'base' : wk.phase);
    default: return null;
  }
}

/** The aerobic stand-in for a hard session. */
export function aerobicVersion(x: Session, p: Profile): Workout | null {
  const d = x.workout.durationMin;
  if (x.sport === 'bike') return bike.endurance(Math.min(d, 75), 0, p);
  if (x.sport === 'run') return run.easy(Math.min(d, 45), -1, p);
  if (x.sport === 'swim') return swim.technique(Math.min(d, 45), 0, p);
  return null;
}

export function proposeAdaptations(s: State, today: string): Adaptation[] {
  const wk = s.season?.weeks[0];
  if (!wk || wk.start !== mondayOf(today)) return [];
  const p = s.profile;
  const end = addDays(wk.start, 6);
  const inWeek = (d: string) => d >= wk.start && d <= end;
  const week = s.sessions.filter((x) => inWeek(x.date));
  const acts = s.activities.filter((a) => inWeek(a.date));
  const isOpen = (x: Session) => x.status === 'planned' && !x.actual && x.sport !== 'race';
  const remaining = week.filter((x) => isOpen(x) && x.date >= today);
  const editable = (x: Session) => !x.locked && x.origin === 'plan';
  const touched = new Set<string>();
  const out: Adaptation[] = [];

  const capOf = (d: string) => dayCap(s.availability, d, dow(d));
  const on = (d: string) => week.filter((x) => x.date === d && x.status !== 'skipped');
  const hardOn = (d: string, except?: Session) => on(d).some((x) => x !== except && (x.workout.hard || x.sport === 'race') && x.sport !== 'strength');
  /** Can session x go on date d without breaking capacity or hard/long spacing? */
  const fits = (x: Session, d: string) => {
    if (!inWeek(d) || d < today || capOf(d) < 30) return false;
    const there = on(d).filter((y) => y !== x);
    if (there.some((y) => y.sport === x.sport || y.sport === 'race')) return false;
    const fx = s.availability.fixed ?? {};
    if (x.sport === 'swim' && !(fx.swim?.length ? fx.swim.includes(dow(d)) : s.availability.days[dow(d)].pool)) return false;
    if (fx.rest === dow(d)) return false;
    if (there.reduce((t, y) => t + y.workout.durationMin, 0) + x.workout.durationMin > capOf(d) + 10) return false;
    if (x.role === 'long' && there.some((y) => y.role === 'long')) return false;
    if (x.workout.hard && (hardOn(d, x) || hardOn(addDays(d, -1), x) || hardOn(addDays(d, 1), x))) return false;
    if (week.some((y) => y.sport === 'race' && diffDays(y.date, d) >= 0 && diffDays(y.date, d) <= 2)) return false;
    return true;
  };

  // ---------- 0. Niggles ----------
  // Severity 2: no intensity in that sport for four days. Severity 3: none of that sport for a
  // week — runs become rides (same aerobic work, no impact); rides and swims are dropped.
  for (const ng of (s.niggles ?? []).filter((x) => !x.resolved && x.severity >= 2)) {
    const until = addDays(today, ng.severity === 3 ? 6 : 3);
    const hit = s.sessions.filter((x) => x.sport === ng.sport && isOpen(x) && x.date >= today && x.date <= until && x.origin !== 'adapted' && !touched.has(x.id) && (ng.severity === 3 || x.workout.hard));
    if (!hit.length) continue;
    const ops: Op[] = [], actions: string[] = [];
    for (const x of hit) {
      touched.add(x.id);
      if (ng.severity === 2) { ops.push({ type: 'easy', id: x.id }); actions.push(`Replace “${x.workout.name}” on ${day(x.date)} with an easy ${ng.sport}.`); }
      else if (ng.sport === 'run' && !s.sessions.some((y) => y.date === x.date && y.sport === 'bike' && y.status !== 'skipped')) { ops.push({ type: 'cross', id: x.id }); actions.push(`Replace “${x.workout.name}” on ${day(x.date)} with an easy ride of similar load.`); }
      else { ops.push({ type: 'skip', id: x.id }); actions.push(`Skip “${x.workout.name}” on ${day(x.date)}.`); }
    }
    out.push({
      key: `niggle:${ng.id}:${ng.severity}:${hit.map((x) => x.id).join(',')}`, kind: 'niggle',
      title: `Protect your ${ng.area}`,
      detail: ng.severity === 3
        ? `You logged pain in your ${ng.area}. No ${ng.sport === 'run' ? 'running' : ng.sport === 'bike' ? 'riding' : 'swimming'} for a week keeps a niggle from becoming an injury; aerobic work continues in the other sports. If it is not clearly better in a week, get it assessed.`
        : `Your ${ng.area} is altering how you move. Intensity is what turns that into an injury, so the next four days of ${ng.sport} stay easy.`,
      actions, ops,
    });
  }

  // ---------- 1. Big day ----------
  const yesterday = addDays(today, -1);
  const plannedFor = (a: Activity) => week.find((x) => x.actual?.activityId === a.id);
  const big = acts.filter((a) => a.date === yesterday || a.date === today).map((a) => {
    const x = plannedFor(a);
    const over = x ? a.tss - x.workout.tss : a.tss;
    const isBig = x ? over >= 40 && a.tss >= x.workout.tss * 1.5 : a.tss >= 100 || ((a.intensity ?? 0) >= 0.9 && a.durationMin >= 40);
    return isBig ? { a, x, over } : null;
  }).filter((v) => v !== null);
  if (big.length) {
    const top = big.sort((m, n) => n.over - m.over)[0];
    const after = top.a.date === today ? [addDays(today, 1)] : [today, addDays(today, 1)];
    // A hard session is only at risk the day after the big effort.
    const victim = remaining.find((x) => x.workout.hard && x.sport !== 'strength' && editable(x) && x.date === addDays(top.a.date, 1) && after.includes(x.date));
    if (victim) {
      const later = [1, 2].map((n) => addDays(victim.date, n)).find((d) => fits(victim, d));
      const what = top.x ? `“${top.a.name}” came in at ${top.a.tss} TSS against ${top.x.workout.tss} planned` : `“${top.a.name}” (${top.a.tss} TSS) was not in the plan`;
      const op: Op = later ? { type: 'move', id: victim.id, date: later } : { type: 'easy', id: victim.id };
      out.push({
        key: `bigday:${top.a.id}:${victim.id}`, kind: 'bigday',
        title: `Protect ${day(victim.date)}’s ${victim.workout.name}`,
        detail: `${day(top.a.date)}’s ${what}. A hard session the next day would be done on tired legs, at lower quality and higher injury risk.`,
        actions: [later ? `Move “${victim.workout.name}” from ${day(victim.date)} to ${day(later)}.` : `Replace “${victim.workout.name}” on ${day(victim.date)} with an easy aerobic session (no later day this week has room for it).`],
        ops: [op],
      });
      touched.add(victim.id);
    }
  }

  // ---------- 2. Overload ----------
  const done = acts.reduce((t, a) => t + a.tss, 0);
  const left = remaining.reduce((t, x) => t + x.workout.tss, 0);
  const projected = done + left;
  const target = wk.targetTss;
  // Only react to load actually done beyond what was planned up to today — never to the plan's own shape.
  const plannedToDate = week.filter((x) => x.date < today && x.sport !== 'race' && x.status !== 'skipped').reduce((t, x) => t + x.workout.tss, 0);
  const ahead = done > plannedToDate * 1.1 + 20;
  if (target > 0 && ahead && projected > target * 1.12 && remaining.length) {
    let excess = projected - target * 1.05;
    const ops: Op[] = [], actions: string[] = [];
    // Easy sessions give up time before the long session does; nothing drops below 60% of its length.
    const trimmable = remaining
      .filter((x) => editable(x) && !touched.has(x.id) && !x.workout.hard && x.sport !== 'strength' && x.role !== 'opener' && x.role !== 'brick' && resized(x, x.workout.durationMin, wk, p))
      .sort((a, b) => (a.role === 'long' ? 1 : 0) - (b.role === 'long' ? 1 : 0) || b.date.localeCompare(a.date));
    for (const x of trimmable) {
      if (excess < 8) break;
      const perMin = x.workout.tss / Math.max(1, x.workout.durationMin);
      const floor = Math.max(x.sport === 'bike' ? 30 : 20, x.workout.durationMin * 0.6);
      const minutes = r5(Math.max(floor, x.workout.durationMin - excess / Math.max(0.1, perMin)));
      if (minutes >= x.workout.durationMin - 4) continue;
      excess -= (x.workout.durationMin - minutes) * perMin;
      ops.push({ type: 'scale', id: x.id, minutes });
      actions.push(`Shorten “${x.workout.name}” on ${day(x.date)} from ${hm(x.workout.durationMin)} to ${hm(minutes)}.`);
      touched.add(x.id);
    }
    // Still well over after trimming: soften the last hard session of the week (tests are left alone).
    if (excess > target * 0.12) {
      const hard = [...remaining].reverse().find((x) => x.workout.hard && editable(x) && !touched.has(x.id) && x.role !== 'test' && x.sport !== 'strength' && aerobicVersion(x, p));
      if (hard) {
        ops.push({ type: 'easy', id: hard.id });
        actions.push(`Replace “${hard.workout.name}” on ${day(hard.date)} with an easy aerobic session.`);
        touched.add(hard.id);
      }
    }
    if (ops.length) {
      out.push({
        key: `overload:${wk.start}:${Math.round(done / 25)}`, kind: 'overload',
        title: 'You are ahead of this week’s load',
        detail: `${Math.round(done)} TSS done so far; with everything still planned the week would reach ${Math.round(projected)} against a target of ${target} (+${Math.round((projected / target - 1) * 100)}%). Extra load is fine once; carried through the week it eats into next week’s quality.`,
        actions, ops,
      });
    }
  }

  // ---------- 3. Missed key session ----------
  const loading = ['rebuild', 'base', 'build', 'specific'].includes(wk.phase) && !wk.recovery;
  if (loading && !out.some((a) => a.kind === 'overload')) {
    const missed = week
      .filter((x) => isOpen(x) && x.date < today && (x.role === 'long' || x.role === 'key') && x.sport !== 'strength' && !touched.has(x.id))
      .sort((a, b) => (a.role === 'long' ? 0 : 1) - (b.role === 'long' ? 0 : 1));
    for (const x of missed) {
      // Keep the week within reach of its target after the move.
      if (projected + x.workout.tss > target * 1.1) continue;
      let to: string | undefined;
      for (let d = today; d <= end; d = addDays(d, 1)) if (fits(x, d)) { to = d; break; }
      out.push(to ? {
        key: `missed:${x.id}:${to}`, kind: 'missed',
        title: `Reschedule the missed ${x.workout.name}`,
        detail: `${day(x.date)}’s ${x.role === 'long' ? 'long session' : 'key session'} was not done. ${day(to)} has the time and keeps hard days apart, so it can still count this week.`,
        actions: [`Move “${x.workout.name}” from ${day(x.date)} to ${day(to)}.`],
        ops: [{ type: 'move', id: x.id, date: to }],
      } : {
        key: `missed:${x.id}:none`, kind: 'missed',
        title: `Let the missed ${x.workout.name} go`,
        detail: `${day(x.date)}’s ${x.role === 'long' ? 'long session' : 'key session'} was not done and no remaining day has room for it without stacking hard days. Leave it: next week’s targets are set from the fitness you actually have, so nothing needs making up.`,
        actions: [], ops: [],
      });
      break; // one rescue per week; more than that is cramming
    }
  }
  const dismissed = new Set(s.dismissedAdapt ?? []);
  return out.filter((a) => !dismissed.has(a.key));
}

/** Apply every current proposal. Changed sessions are pinned and annotated. */
export function applyAdaptations(s: State, today: string): string[] {
  const wk = s.season?.weeks[0];
  const changes: string[] = [];
  if (!wk) return changes;
  for (const a of proposeAdaptations(s, today)) {
    for (const op of a.ops) {
      const x = s.sessions.find((q) => q.id === op.id);
      if (!x) continue;
      const before = x.workout.name;
      if (op.type === 'skip') {
        x.status = 'skipped';
        x.adaptedNote = `Skipped: ${a.title.toLowerCase()}.`;
        changes.push(`Skipped “${before}” on ${day(x.date)}.`);
      } else if (op.type === 'cross') {
        const w = bike.endurance(Math.min(90, r5(x.workout.durationMin * 1.2)), 0, s.profile);
        x.workout = w; x.sport = 'bike'; x.role = 'easy';
        x.adaptedNote = `Replaced “${before}” with a ride: ${a.title.toLowerCase()}.`;
        changes.push(`Replaced “${before}” on ${day(x.date)} with “${w.name}”.`);
      } else if (op.type === 'move') {
        const from = x.date;
        x.date = op.date;
        x.adaptedNote = `Moved from ${day(from)} to ${day(op.date)}: ${a.title.toLowerCase()}.`;
        changes.push(`Moved “${before}” from ${day(from)} to ${day(op.date)}.`);
      } else {
        const w = op.type === 'scale' ? resized(x, op.minutes, wk, s.profile) : aerobicVersion(x, s.profile);
        if (!w) continue;
        const was = x.workout.durationMin;
        x.workout = w;
        if (op.type === 'easy') x.role = 'easy';
        x.adaptedNote = op.type === 'scale' ? `Shortened from ${hm(was)} to ${hm(w.durationMin)}: ${a.title.toLowerCase()}.` : `Replaced “${before}”: ${a.title.toLowerCase()}.`;
        changes.push(op.type === 'scale' ? `Shortened “${before}” on ${day(x.date)} to ${hm(w.durationMin)}.` : `Replaced “${before}” on ${day(x.date)} with “${w.name}”.`);
      }
      x.locked = true;
      x.origin = 'adapted';
    }
    // Advice-only proposals are acknowledged so they do not reappear.
    if (!a.ops.length) (s.dismissedAdapt ??= []).push(a.key);
  }
  s.sessions.sort((a, b) => a.date.localeCompare(b.date));
  return changes;
}
