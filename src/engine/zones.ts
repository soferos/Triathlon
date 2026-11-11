// Intensity model: every step stores a fraction of the sport's threshold. This module turns
// fractions into watts / pace / heart rate, estimates load, and renders Intervals.icu text.
import type { Block, Profile, Sport, Step, Workout } from './types.ts';

export interface Zone { id: string; name: string; lo: number; hi: number }

// Bike: classic power zones relative to FTP (Coggan), with Z2 capped near the first lactate threshold.
export const BIKE_ZONES: Zone[] = [
  { id: 'Z1', name: 'Recovery', lo: 0, hi: 0.55 },
  { id: 'Z2', name: 'Endurance', lo: 0.56, hi: 0.75 },
  { id: 'Z3', name: 'Tempo', lo: 0.76, hi: 0.87 },
  { id: 'SS', name: 'Sweet spot', lo: 0.88, hi: 0.94 },
  { id: 'Z4', name: 'Threshold', lo: 0.95, hi: 1.05 },
  { id: 'Z5', name: 'VO2max', lo: 1.06, hi: 1.2 },
  { id: 'Z6', name: 'Anaerobic', lo: 1.21, hi: 1.5 },
];
// Run: power and speed zones are far more compressed around threshold than cycling zones.
export const RUN_ZONES: Zone[] = [
  { id: 'Z1', name: 'Recovery', lo: 0, hi: 0.77 },
  { id: 'Z2', name: 'Endurance', lo: 0.78, hi: 0.87 },
  { id: 'Z3', name: 'Steady / tempo', lo: 0.88, hi: 0.95 },
  { id: 'Z4', name: 'Threshold', lo: 0.96, hi: 1.03 },
  { id: 'Z5', name: 'VO2max', lo: 1.04, hi: 1.15 },
  { id: 'Z6', name: 'Speed', lo: 1.16, hi: 1.4 },
];
export const SWIM_ZONES: Zone[] = [
  { id: 'Z1', name: 'Easy / technique', lo: 0, hi: 0.86 },
  { id: 'Z2', name: 'Aerobic', lo: 0.87, hi: 0.94 },
  { id: 'Z3', name: 'CSS / threshold', lo: 0.95, hi: 1.02 },
  { id: 'Z4', name: 'VO2 / race start', lo: 1.03, hi: 1.1 },
  { id: 'Z5', name: 'Sprint', lo: 1.11, hi: 1.3 },
];

const lerp = (pts: [number, number][], x: number) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
};
/** Map a power/speed fraction to the matching fraction of lactate-threshold heart rate. */
export function hrFraction(sport: Sport, f: number): number {
  const bike: [number, number][] = [[0.45, 0.62], [0.55, 0.7], [0.75, 0.84], [0.9, 0.94], [1, 1], [1.1, 1.04]];
  const run: [number, number][] = [[0.65, 0.7], [0.78, 0.82], [0.88, 0.91], [1, 1], [1.1, 1.04]];
  return lerp(sport === 'run' ? run : bike, f);
}

export const fmtClock = (secs: number) => {
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export function fmtDuration(secs: number): string {
  if (secs < 60) return `${Math.round(secs)} s`;
  if (secs % 60 === 0 && secs < 3600) return `${secs / 60} min`;
  if (secs < 3600) return `${fmtClock(secs)} min`;
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

type Mode = 'power' | 'pace' | 'hr';
export function targetMode(sport: Sport, p: Profile): Mode {
  if (sport === 'bike') return p.bikeTarget;
  if (sport === 'run') return p.runTarget;
  return 'pace';
}

const range = (a: number, b: number, unit: string) => {
  const x = Math.round(a), y = Math.round(b);
  return x === y ? `${x} ${unit}` : `${x}–${y} ${unit}`;
};
const pct = (lo: number, hi: number) => {
  const a = Math.round(lo * 100), b = Math.round(hi * 100);
  return a === b ? `${a}%` : `${a}-${b}%`;
};

/** Human-readable absolute target for a step, falling back to % of threshold when a threshold is unknown. */
export function targetLabel(sport: Sport, s: Step, p: Profile): string {
  if (s.kind === 'rest') return 'rest';
  const mode = targetMode(sport, p);
  if (sport === 'swim') {
    if (!p.cssSecPer100) return `${pct(s.lo, s.hi)} CSS`;
    const slow = fmtClock(p.cssSecPer100 / s.lo), fast = fmtClock(p.cssSecPer100 / s.hi);
    return slow === fast ? `${fast} /100m` : `${slow}–${fast} /100m`;
  }
  if (mode === 'hr') {
    const lthr = sport === 'bike' ? p.bikeLthr : p.runLthr;
    const lo = hrFraction(sport, s.lo), hi = hrFraction(sport, s.hi);
    return lthr ? range(lo * lthr, hi * lthr, 'bpm') : `${pct(lo, hi)} LTHR`;
  }
  if (mode === 'pace') {
    if (!p.runPaceSecPerKm) return `${pct(s.lo, s.hi)} threshold pace`;
    const slow = fmtClock(p.runPaceSecPerKm / s.lo), fast = fmtClock(p.runPaceSecPerKm / s.hi);
    return slow === fast ? `${fast} /km` : `${slow}–${fast} /km`;
  }
  const thr = sport === 'bike' ? p.ftp : p.runPower;
  return thr ? range(s.lo * thr, s.hi * thr, 'W') : `${pct(s.lo, s.hi)} ${sport === 'bike' ? 'FTP' : 'threshold power'}`;
}

const DEFAULT_CSS = 100; // s/100m, only used to estimate swim durations before CSS is known
export function stepSecs(s: Step, p: Profile): number {
  if (s.secs != null) return s.secs;
  const css = p.cssSecPer100 || DEFAULT_CSS;
  return ((s.meters ?? 0) / 100) * (css / ((s.lo + s.hi) / 2 || 0.85));
}

/** Duration (min), load (TSS-equivalent: hours x IF^2 x 100) and distance for a set of blocks. */
export function measure(blocks: Block[], p: Profile) {
  let secs = 0, load = 0, meters = 0;
  for (const b of blocks) {
    for (const s of b.steps) {
      const t = stepSecs(s, p) * b.repeat;
      const f = s.kind === 'rest' ? 0 : (s.lo + s.hi) / 2;
      secs += t;
      load += (t / 3600) * f * f * 100;
      meters += (s.meters ?? 0) * b.repeat;
    }
  }
  return { durationMin: Math.round(secs / 60), tss: Math.round(load), meters };
}

/** Recompute duration and load, e.g. after thresholds change or for a custom workout. */
export function finalize(w: Workout, p: Profile): Workout {
  if (w.sport === 'strength' || w.sport === 'race' || !w.blocks.length) return w;
  const m = measure(w.blocks, p);
  return { ...w, durationMin: m.durationMin, tss: m.tss };
}

// ---------- Intervals.icu workout text ----------

function icuDuration(s: Step): string {
  if (s.meters != null) return `${s.meters}mtr`;
  const secs = s.secs ?? 0;
  if (secs % 60 === 0) return `${secs / 60}m`;
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m${secs % 60}s`;
}

function icuTarget(sport: Sport, s: Step, p: Profile): string {
  if (s.kind === 'rest') return '';
  const mode = targetMode(sport, p);
  const ramp = s.ramp ? 'ramp ' : '';
  if (mode === 'hr') return `${ramp}${pct(hrFraction(sport, s.lo), hrFraction(sport, s.hi))} LTHR`;
  if (mode === 'pace') return `${ramp}${pct(s.lo, s.hi)} Pace`;
  return `${ramp}${pct(s.lo, s.hi)}`;
}

// Cues become step labels; strip anything the Intervals.icu parser could read as a duration or target.
const cleanCue = (c: string) => c.replace(/[0-9%@^]/g, '').replace(/\s+/g, ' ').trim();

/** Render a workout in Intervals.icu's workout-builder text syntax (parsed server-side into structured steps). */
export function toIcuText(w: Workout, p: Profile): string {
  const out: string[] = [];
  if (w.description) out.push(w.description, '');
  if (w.notes) out.push(w.notes, '');
  if (w.exercises?.length) {
    for (const e of w.exercises) out.push(`• ${e.name}: ${e.sets} @ ${e.load}${e.note ? ` (${e.note})` : ''}`);
    return out.join('\n').trim();
  }
  for (const b of w.blocks) {
    out.push(b.repeat > 1 ? `${b.name} ${b.repeat}x` : b.name);
    for (const s of b.steps) {
      const label = s.kind === 'rest' ? 'Rest' : s.cue ? cleanCue(s.cue) : '';
      const parts = ['-', label, icuDuration(s), icuTarget(w.sport, s, p)];
      if (s.cadence && w.sport === 'bike') parts.push(`${s.cadence}rpm`);
      out.push(parts.filter(Boolean).join(' '));
    }
    out.push('');
  }
  return out.join('\n').trim();
}

/** Structured view for the UI: absolute targets per step. */
export function viewWorkout(w: Workout, p: Profile) {
  return w.blocks.map((b) => ({
    name: b.name,
    repeat: b.repeat,
    steps: b.steps.map((s) => ({
      kind: s.kind,
      dur: s.meters != null ? `${s.meters} m` : fmtDuration(s.secs ?? 0),
      target: targetLabel(w.sport, s, p),
      cue: s.cue ?? '',
      cadence: s.cadence,
      lo: s.lo, hi: s.hi,
      secs: stepSecs(s, p),
    })),
  }));
}

export function zoneTable(p: Profile) {
  const row = (sport: Sport, zones: Zone[]) =>
    zones.map((z) => ({
      id: z.id, name: z.name,
      pct: `${Math.round(z.lo * 100)}–${Math.round(z.hi * 100)}%`,
      target: targetLabel(sport, { kind: 'work', secs: 60, lo: Math.max(z.lo, 0.4), hi: z.hi }, p),
    }));
  return { bike: row('bike', BIKE_ZONES), run: row('run', RUN_ZONES), swim: row('swim', SWIM_ZONES) };
}
