// Execution analysis: grades a completed key session rep by rep against its prescription, using
// the intervals Intervals.icu detected in the activity, and turns that into progression.
import type { Execution, Profile, Session, Sport } from './types.ts';
import { stepSecs } from './zones.ts';

/** One detected interval from GET /activity/{id}/intervals (only the fields used here). */
export interface IcuInterval { type?: string; moving_time?: number; elapsed_time?: number; average_watts?: number; average_speed?: number; distance?: number }

const HARD: Record<string, number> = { bike: 0.86, run: 0.88, swim: 0.94 };

/** The reps that define the session: its work steps at or above tempo, expanded across repeats. */
export function plannedReps(x: Session, p: Profile): { secs: number; lo: number; hi: number }[] {
  const out: { secs: number; lo: number; hi: number }[] = [];
  for (const b of x.workout.blocks) {
    for (let r = 0; r < b.repeat; r++) {
      for (const s of b.steps) {
        const secs = stepSecs(s, p);
        if (s.kind === 'work' && s.hi >= (HARD[x.sport] ?? 0.9) && secs >= 25) out.push({ secs, lo: s.lo, hi: s.hi });
      }
    }
  }
  if (!out.length) return out;
  // Sessions mix primers/strides with the main set; grade the set that carries the most work.
  const groups = new Map<string, typeof out>();
  for (const r of out) { const k = `${Math.round(r.secs / 10)}|${r.lo}|${r.hi}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  return [...groups.values()].sort((a, b) => b.reduce((t, r) => t + r.secs, 0) - a.reduce((t, r) => t + r.secs, 0))[0];
}

function fraction(sport: Sport, iv: IcuInterval, p: Profile): number | undefined {
  const speed = iv.average_speed ?? (iv.distance && iv.moving_time ? iv.distance / iv.moving_time : undefined);
  if (sport === 'bike') return p.ftp && iv.average_watts ? iv.average_watts / p.ftp : undefined;
  if (sport === 'run') {
    if (p.runTarget === 'power' && p.runPower && iv.average_watts) return iv.average_watts / p.runPower;
    return p.runPaceSecPerKm && speed ? speed / (1000 / p.runPaceSecPerKm) : undefined;
  }
  if (sport === 'swim') return p.cssSecPer100 && speed ? speed / (100 / p.cssSecPer100) : undefined;
  return undefined;
}

export function analyzeExecution(x: Session, intervals: IcuInterval[], p: Profile): Execution | null {
  const reps = plannedReps(x, p);
  if (!reps.length) return null;
  const { secs, lo, hi } = reps[0];
  const pct = (f: number) => `${Math.round(f * 100)}%`;
  const done = intervals
    .filter((iv) => (iv.type ?? 'WORK').toUpperCase() === 'WORK')
    .map((iv) => ({ t: iv.moving_time ?? iv.elapsed_time ?? 0, f: fraction(x.sport, iv, p) }))
    // A rep counts when it is roughly the prescribed length and clearly not recovery pace.
    .filter((r) => r.t >= secs * 0.6 && r.t <= secs * 1.6 && r.f != null && r.f >= lo - 0.12) as { t: number; f: number }[];
  const base = { plannedReps: reps.length, doneReps: done.length, lo, hi };
  if (!done.length) {
    return { ...base, verdict: 'unstructured', text: `No intervals matching ${reps.length} × ${Math.round(secs / 60 * 10) / 10} min were found in the activity, so it could not be graded rep by rep. Laps or auto-detected intervals in Intervals.icu make this work.` };
  }
  const avg = done.reduce((t, r) => t + r.f, 0) / done.length;
  const fade = done.length >= 3 ? Math.round(((done.at(-1)!.f - done[0].f) / done[0].f) * 1000) / 10 : undefined;
  const fadeTxt = fade == null ? '' : fade <= -4 ? ` Intensity faded ${Math.abs(fade)}% from first to last rep — the opening reps were too hard or the session was a level too far.` : fade >= 4 ? ` You built ${fade}% through the set.` : ' Even from first rep to last.';
  const range = `${pct(lo)}–${pct(hi)}`;
  let verdict: Execution['verdict'], text: string;
  if (done.length < reps.length * 0.75) { verdict = 'cut short'; text = `${done.length} of ${reps.length} reps completed at ${pct(avg)} (target ${range}).`; }
  else if (avg < lo - 0.025) { verdict = 'under'; text = `All reps done but at ${pct(avg)} against a target of ${range}.`; }
  else if (avg > hi + 0.025) { verdict = 'over'; text = `Reps averaged ${pct(avg)}, above the ${range} target.`; }
  else { verdict = 'nailed'; text = `${done.length} of ${reps.length} reps at ${pct(avg)}, inside the ${range} target.`; }
  return { ...base, verdict, avg: Math.round(avg * 1000) / 1000, fade, text: text + fadeTxt };
}

/** 'bike.vo2.3015' and 'bike.vo2' progress together. */
export const progressKey = (code: string) => code.split('.').slice(0, 2).join('.');

/**
 * Progression from execution: beat the target with all reps done and no fade -> skip a level next
 * time; fail to complete or hold it -> repeat a level down. Bounded so one day cannot derail a block.
 */
export function progressDelta(e: Execution): number {
  if (e.verdict === 'over' && (e.fade ?? 0) > -4) return 1;
  if (e.verdict === 'under' || e.verdict === 'cut short') return -1;
  if (e.verdict === 'nailed' && (e.fade ?? 0) <= -6) return -1;
  return 0;
}
export function applyProgress(progress: Record<string, number>, code: string, e: Execution): number {
  const k = progressKey(code), d = progressDelta(e);
  if (d) progress[k] = Math.max(-2, Math.min(2, (progress[k] ?? 0) + d));
  return d;
}
