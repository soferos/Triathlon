// Workout library. Every builder takes a target duration (min) and a progression level and returns
// a fully structured session. Intensities are fractions of threshold (see zones.ts).
import type { Block, Category, CourseDemands, Profile, Sport, Step, TriDistance, Workout } from './types.ts';
import { measure } from './zones.ts';

type X = Partial<Step>;
const S = (kind: Step['kind'], secs: number, lo: number, hi: number, x: X = {}): Step => ({ kind, secs, lo, hi, ...x });
const M = (kind: Step['kind'], meters: number, lo: number, hi: number, x: X = {}): Step => ({ kind, meters, lo, hi, ...x });
const rest = (secs: number): Step => ({ kind: 'rest', secs, lo: 0, hi: 0 });
const blk = (name: string, repeat: number, steps: Step[]): Block => ({ name, repeat, steps });
const secsOf = (b: Block[]) => b.reduce((t, x) => t + x.repeat * x.steps.reduce((a, s) => a + (s.secs ?? 0), 0), 0);
const round5 = (min: number) => Math.max(5, Math.round(min / 5) * 5);

export function fuel(dur: number, hard: boolean): string {
  const h = dur / 60, tot = (lo: number, hi: number) => `about ${Math.round((lo * h) / 5) * 5}–${Math.round((hi * h) / 5) * 5} g`;
  if (dur >= 150) return `Fuel: 80–100 g carbohydrate/h (glucose + fructose) — ${tot(80, 100)} for this session — and 500–750 ml/h with sodium. Rehearse race nutrition.`;
  if (dur >= 75 || (hard && dur >= 60)) return `Fuel: 60–90 g carbohydrate/h from the first 20 min (${tot(60, 90)} in total); start well fed.`;
  return hard ? 'Fuel: carbohydrate-rich meal 2–3 h before; this session needs glycogen.' : 'Fuel: water/electrolytes is enough; eat normally afterwards.';
}

function make(
  sport: Sport, code: string, name: string, category: Category, hard: boolean,
  blocks: Block[], description: string, p: Profile,
): Workout {
  const m = measure(blocks, p);
  return { sport, code, name, category, hard, blocks, description, notes: fuel(m.durationMin, hard), durationMin: m.durationMin, tss: m.tss };
}

/** [reps, workSecs, recoverySecs] — choose the hardest row <= lvl that fits the time budget. */
type Row = [number, number, number];
function pick(table: Row[], lvl: number, budgetSecs: number): Row {
  for (let i = Math.min(Math.max(lvl, 0), table.length - 1); i > 0; i--) {
    const [r, w, rec] = table[i];
    if (r * (w + rec) <= budgetSecs) return table[i];
  }
  const [r, w, rec] = table[0];
  const reps = Math.max(2, Math.min(r, Math.floor(budgetSecs / (w + rec))));
  return [reps, w, rec];
}
const setName = ([r, w]: Row) => `${r}×${w >= 60 ? `${Math.round(w / 60)} min` : `${w} s`}`;

/** Warm-up + main + easy filler + cool-down, sized to `dur` minutes. */
function assemble(dur: number, wu: Block, main: Block[], cd: Block, filler: (secs: number) => Block, fillFirst = false): Block[] {
  const left = dur * 60 - secsOf([wu, ...main, cd]);
  const fill = left >= 300 ? [filler(Math.round(left / 60) * 60)] : [];
  return fillFirst ? [wu, ...fill, ...main, cd] : [wu, ...main, ...fill, cd];
}

// ============================== BIKE ==============================
const bWu = (min = 12) => blk('Warm-up', 1, [S('warmup', min * 60, 0.5, 0.72, { ramp: true })]);
const bCd = (min = 8) => blk('Cool-down', 1, [S('cooldown', min * 60, 0.45, 0.55)]);
const bZ2 = (secs: number) => blk('Endurance', 1, [S('work', secs, 0.65, 0.75, { cue: 'Steady aerobic' })]);
const bPrimer = blk('Primer', 3, [S('work', 60, 0.95, 1.05, { cue: 'Fast cadence', cadence: 100 }), S('recovery', 60, 0.5, 0.55)]);

export const bike = {
  recovery: (dur: number, _l: number, p: Profile) =>
    make('bike', 'bike.recovery', 'Recovery spin', 'recovery', false,
      [blk('Spin', 1, [S('work', dur * 60, 0.45, 0.55, { cadence: 90 })])],
      'Genuinely easy. If it feels like training, back off.', p),

  endurance: (dur: number, lvl: number, p: Profile) => {
    const sprints = lvl >= 1 && dur >= 60;
    const main = sprints ? [blk('Sprints', 6, [S('work', 10, 1.5, 2, { cue: 'Max seated sprint' }), S('recovery', 290, 0.6, 0.7)])] : [];
    return make('bike', 'bike.endurance', sprints ? 'Endurance + neuromuscular sprints' : 'Aerobic endurance', 'endurance', false,
      assemble(dur, bWu(10), main, bCd(5), bZ2),
      sprints
        ? 'Upper Z2 with 6×10 s maximal sprints: recruits fast fibres at negligible fatigue cost.'
        : 'Upper Z2, just under the first lactate threshold. Conversational, nasal-breathing pace; hold cadence 85–95.', p);
  },

  sweetspot: (dur: number, lvl: number, p: Profile) => {
    const row = pick([[3, 600, 240], [3, 720, 240], [3, 900, 300], [2, 1200, 300], [3, 1200, 300], [2, 1800, 420]], lvl, dur * 60 - 1200);
    return make('bike', 'bike.sweetspot', `Sweet spot ${setName(row)}`, 'tempo', true,
      assemble(dur, bWu(), [blk('Sweet spot', row[0], [S('work', row[1], 0.88, 0.93, { cue: 'Smooth and controlled' }), S('recovery', row[2], 0.5, 0.6)])], bCd(), bZ2),
      'High aerobic stimulus per unit of fatigue. Should feel like 6–7/10; finish knowing you could do one more.', p);
  },

  threshold: (dur: number, lvl: number, p: Profile) => {
    const row = pick([[4, 480, 180], [5, 480, 180], [3, 720, 240], [4, 600, 240], [3, 900, 300], [2, 1200, 360], [3, 1200, 360]], lvl, dur * 60 - 1500);
    return make('bike', 'bike.threshold', `Threshold ${setName(row)}`, 'threshold', true,
      assemble(dur, bWu(), [bPrimer, blk('Threshold', row[0], [S('work', row[1], 0.96, 1.02, { cue: 'Hold threshold' }), S('recovery', row[2], 0.5, 0.55)])], bCd(), bZ2),
      'Sustained work at maximal lactate steady state. Even power across all reps beats a heroic first one.', p);
  },

  overunder: (dur: number, lvl: number, p: Profile) => {
    const sets = Math.min(2 + Math.floor(lvl / 2), 4);
    const set = blk('Over-unders', sets, [
      S('work', 120, 0.92, 0.95, { cue: 'Under' }), S('work', 60, 1.05, 1.1, { cue: 'Over' }),
      S('work', 120, 0.92, 0.95, { cue: 'Under' }), S('work', 60, 1.05, 1.1, { cue: 'Over' }),
      S('work', 120, 0.92, 0.95, { cue: 'Under' }), S('work', 60, 1.05, 1.1, { cue: 'Over' }),
      S('recovery', 300, 0.5, 0.55),
    ]);
    return make('bike', 'bike.overunder', `Over-unders ${sets}×9 min`, 'threshold', true,
      assemble(dur, bWu(), [bPrimer, set], bCd(), bZ2),
      'Lactate shuttling: surge above threshold, then clear it while still working. Race-relevant for hills and surges.', p);
  },

  vo2: (dur: number, lvl: number, p: Profile) => {
    if (lvl % 3 === 2) {
      const sets = dur >= 75 ? 3 : 2;
      const main: Block[] = [bPrimer];
      for (let i = 0; i < sets; i++) {
        main.push(blk('Thirty-fifteens', 13, [S('work', 30, 1.2, 1.3, { cue: 'On' }), S('recovery', 15, 0.5, 0.5, { cue: 'Float' })]));
        if (i < sets - 1) main.push(blk('Set recovery', 1, [S('recovery', 180, 0.45, 0.55)]));
      }
      return make('bike', 'bike.vo2.3015', `VO2max ${sets}×13×30/15`, 'vo2', true,
        assemble(dur, bWu(15), main, bCd(), bZ2),
        'Rønnestad 30/15s: more time above 90% VO2max than classic long intervals. The 15 s floats are easy pedalling, not stops.', p);
    }
    const row = pick([[5, 180, 180], [5, 240, 210], [6, 240, 210], [5, 300, 240], [6, 300, 240]], lvl, dur * 60 - 1620);
    return make('bike', 'bike.vo2', `VO2max ${setName(row)}`, 'vo2', true,
      assemble(dur, bWu(15), [bPrimer, blk('VO2max', row[0], [S('work', row[1], 1.1, 1.18, { cue: 'Hard start then hold', cadence: 100 }), S('recovery', row[2], 0.45, 0.55)])], bCd(), bZ2),
      'Maximal sustainable effort for the rep length; breathing should be ragged by the last minute. Raises the aerobic ceiling.', p);
  },

  racepace: (dur: number, lvl: number, p: Profile, d: TriDistance) => {
    const spec: Record<TriDistance, { t: Row[]; lo: number; hi: number; label: string }> = {
      sprint: { t: [[3, 360, 180], [3, 480, 180], [4, 480, 180], [3, 600, 180]], lo: 0.97, hi: 1.03, label: 'sprint-distance' },
      olympic: { t: [[3, 600, 240], [3, 720, 240], [2, 1200, 300], [3, 900, 240]], lo: 0.9, hi: 0.96, label: 'Olympic-distance' },
      half: { t: [[3, 900, 300], [3, 1200, 300], [4, 1200, 300], [2, 2400, 420], [3, 1800, 300]], lo: 0.8, hi: 0.86, label: '70.3' },
      full: { t: [[2, 1800, 300], [3, 1800, 300], [3, 2400, 300], [2, 3600, 420]], lo: 0.68, hi: 0.75, label: 'Ironman' },
    };
    const s = spec[d];
    const row = pick(s.t, lvl, dur * 60 - 1200);
    return make('bike', 'bike.racepace', `Race pace ${setName(row)}`, 'racepace', true,
      assemble(dur, bWu(), [blk('Race pace', row[0], [S('work', row[1], s.lo, s.hi, { cue: 'Aero position race effort' }), S('recovery', row[2], 0.55, 0.6)])], bCd(5), bZ2),
      `Target ${s.label} power in the aero position, on race equipment, taking race nutrition. Specificity over heroics.`, p);
  },

  /** Race-specific session built from the target course: its climbs become the intervals. */
  course: (dur: number, lvl: number, p: Profile, d: TriDistance, c: CourseDemands) => {
    const climbs = c.climbMin.filter((m) => m >= 4);
    if (climbs.length && c.terrain !== 'flat') {
      const mid = [...climbs].sort((a, b) => a - b)[climbs.length >> 1];
      const secs = Math.round(Math.max(5, Math.min(25, mid))) * 60;
      const cf = Math.max(0.8, Math.min(1.05, c.climbFrac));
      const budget = dur * 60 - 1500;
      const reps = Math.max(2, Math.min(climbs.length + (lvl >= 2 ? 1 : 0), 2 + lvl, 6, Math.floor(budget / (secs * 1.5))));
      return make('bike', 'bike.course', `Course climbs ${reps}×${secs / 60} min`, 'racepace', true,
        assemble(dur, bWu(), [bPrimer, blk('Course climb', reps, [S('work', secs, cf - 0.03, cf + 0.02, { cue: 'Climb at race power seated', cadence: 75 }), S('recovery', Math.round(secs / 2 / 60) * 60, 0.5, 0.6, { cue: 'Descend and reset' })])], bCd(), bZ2),
        `Your race course has ${climbs.length} climb${climbs.length === 1 ? '' : 's'} of around ${Math.round(mid)} min. These reps are those climbs at the power your pacing plan calls for, on the gearing and cadence you will race. Ride them on a real climb when you can.`, p);
    }
    if (c.terrain === 'rolling') {
      const rp = { sprint: 0.97, olympic: 0.92, half: 0.82, full: 0.71 }[d];
      const sets = Math.max(2, Math.min(2 + Math.floor(lvl / 2), 4, Math.floor((dur * 60 - 1320) / 1260)));
      const roller = [S('work', 90, rp + 0.1, rp + 0.16, { cue: 'Roller push over the top' }), S('work', 150, rp - 0.08, rp - 0.03, { cue: 'Settle to race power' })];
      return make('bike', 'bike.course', `Rolling course ${sets}×16 min`, 'racepace', true,
        assemble(dur, bWu(), [blk('Rollers', sets, [...roller, ...roller, ...roller, ...roller, S('recovery', 300, 0.55, 0.6)])], bCd(), bZ2),
        'Your race course rolls constantly. This rehearses surging over each rise and settling straight back to race power without a recovery — the skill that keeps normalised power honest on that terrain.', p);
    }
    return bike.racepace(dur, lvl, p, d);
  },

  long: (dur: number, lvl: number, p: Profile, phase: string, d: TriDistance) => {
    let main: Block[] = [];
    let desc = 'Long aerobic ride. Keep it honest in upper Z2 — durability comes from time, not surges.';
    const budget = dur * 60 - 2400;
    if (phase === 'base' && lvl >= 2 && budget > 2400) {
      const row = pick([[2, 900, 600], [3, 900, 600], [3, 1200, 600]], lvl - 2, budget);
      main = [blk('Tempo', row[0], [S('work', row[1], 0.78, 0.85, { cue: 'Tempo', cadence: 80 }), S('recovery', row[2], 0.62, 0.7)])];
      desc = 'Long ride with tempo blocks at low-ish cadence for muscular endurance.';
    } else if (phase === 'build' && budget > 2400) {
      const row = pick([[2, 1200, 600], [3, 1200, 600], [3, 1500, 600], [3, 1800, 600]], lvl, budget);
      main = [blk('Late tempo', row[0], [S('work', row[1], 0.8, 0.88, { cue: 'Strong tempo on tired legs' }), S('recovery', row[2], 0.6, 0.68)])];
      desc = 'Durability ride: the quality comes in the back half, when power at threshold normally decays.';
    } else if ((phase === 'specific' || phase === 'taper') && budget > 2400) {
      const rp = { sprint: [0.92, 0.98], olympic: [0.86, 0.92], half: [0.78, 0.84], full: [0.68, 0.74] }[d];
      const row = pick([[2, 1800, 600], [3, 1800, 600], [3, 2400, 600], [2, 3600, 600], [3, 3600, 600]], lvl, budget);
      main = [blk('Race simulation', row[0], [S('work', row[1], rp[0], rp[1], { cue: 'Race power in aero' }), S('recovery', row[2], 0.6, 0.65)])];
      desc = 'Race simulation: goal power, aero position, full race fuelling and hydration plan. Note what your gut tolerates.';
    }
    return make('bike', 'bike.long', main.length ? `Long ride · ${main[0].name.toLowerCase()}` : 'Long ride', main.length ? 'tempo' : 'endurance', false,
      assemble(dur, bWu(15), main, bCd(10), bZ2, true), desc, p);
  },

  openers: (dur: number, _l: number, p: Profile) =>
    make('bike', 'bike.openers', 'Openers', 'speed', false,
      assemble(dur, bWu(10), [blk('Openers', 3, [S('work', 60, 1, 1.08, { cue: 'Race effort' }), S('recovery', 120, 0.5, 0.55)]),
        blk('Sprints', 3, [S('work', 15, 1.4, 1.7, { cue: 'Spin up' }), S('recovery', 105, 0.5, 0.55)])], bCd(5), bZ2),
      'Prime the system without adding fatigue. Check gears, brakes and race wheels while you are at it.', p),

  test: (_d: number, _l: number, p: Profile) =>
    make('bike', 'bike.test', 'FTP test (20 min)', 'test', true, [
      bWu(15), bPrimer,
      blk('Blow-out', 1, [S('work', 300, 1.05, 1.1, { cue: 'Hard clearing effort' }), S('recovery', 600, 0.5, 0.55)]),
      blk('Test', 1, [S('work', 1200, 0.98, 1.08, { cue: 'Best even effort' })]),
      bCd(10),
    ], 'FTP ≈ 95% of 20-min average power. Pace it: the last 5 min should be the hardest, not the first. Update your threshold afterwards.', p),
};

// ============================== RUN ==============================
const rWu = (min = 12) => blk('Warm-up', 1, [S('warmup', min * 60, 0.72, 0.82, { ramp: true })]);
const rCd = (min = 8) => blk('Cool-down', 1, [S('cooldown', min * 60, 0.7, 0.78)]);
const rZ2 = (secs: number) => blk('Easy running', 1, [S('work', secs, 0.78, 0.86, { cue: 'Relaxed aerobic' })]);
const strides = (n = 6) => blk('Strides', n, [S('work', 20, 1.15, 1.25, { cue: 'Fast and relaxed' }), S('recovery', 70, 0.65, 0.75)]);

export const run = {
  recovery: (dur: number, _l: number, p: Profile) =>
    make('run', 'run.recovery', 'Recovery run', 'recovery', false,
      [blk('Jog', 1, [S('work', dur * 60, 0.68, 0.76)])], 'Very easy, soft surface if possible. Skip it if anything hurts.', p),

  easy: (dur: number, lvl: number, p: Profile) => {
    const st = lvl >= 0 && dur >= 35;
    return make('run', 'run.easy', st ? 'Easy run + strides' : 'Easy run', 'endurance', false,
      st ? [blk('Easy running', 1, [S('work', (dur - 14) * 60, 0.78, 0.86)]), strides(6), rCd(5)] : [blk('Easy running', 1, [S('work', dur * 60, 0.78, 0.86)])],
      st ? 'Easy aerobic running, then 6×20 s strides: fast, tall, relaxed — neuromuscular work, not conditioning.' : 'Easy aerobic running at a pace you could hold for hours.', p);
  },

  hills: (dur: number, lvl: number, p: Profile) => {
    const row = pick([[6, 45, 105], [8, 45, 105], [8, 60, 120], [10, 60, 120]], lvl, dur * 60 - 1500);
    return make('run', 'run.hills', `Hill reps ${setName(row)}`, 'vo2', true,
      assemble(dur, rWu(15), [blk('Hills', row[0], [S('work', row[1], 1.1, 1.2, { cue: 'Uphill strong form' }), S('recovery', row[2], 0.6, 0.7, { cue: 'Jog down' })])], rCd(), rZ2),
      'Hill reps on a 5–8% grade: high force and cardiac demand with less impact than flat speedwork — ideal early in a block. Power is the right target here; pace is meaningless uphill.', p);
  },

  tempo: (dur: number, lvl: number, p: Profile) => {
    const row = pick([[2, 600, 120], [2, 900, 120], [1, 1500, 0], [2, 1200, 120], [1, 2400, 0]], lvl, dur * 60 - 1200);
    return make('run', 'run.tempo', `Tempo ${setName(row)}`, 'tempo', true,
      assemble(dur, rWu(), [blk('Tempo', row[0], [S('work', row[1], 0.9, 0.95, { cue: 'Comfortably hard' }), ...(row[2] ? [S('recovery', row[2], 0.7, 0.75)] : [])])], rCd(), rZ2),
      'Steady state between the two thresholds — half-marathon-ish effort. Controlled, rhythmic, repeatable.', p);
  },

  threshold: (dur: number, lvl: number, p: Profile) => {
    const row = pick([[5, 300, 60], [6, 300, 60], [4, 480, 90], [5, 480, 90], [3, 720, 120], [4, 720, 120]], lvl, dur * 60 - 1320);
    return make('run', 'run.threshold', `Threshold ${setName(row)}`, 'threshold', true,
      assemble(dur, rWu(), [strides(3), blk('Threshold', row[0], [S('work', row[1], 0.97, 1.02, { cue: 'Threshold not faster' }), S('recovery', row[2], 0.65, 0.72, { cue: 'Jog' })])], rCd(), rZ2),
      'Cruise intervals with short recoveries: lots of volume at threshold with controlled lactate. Discipline matters — faster is a different session.', p);
  },

  vo2: (dur: number, lvl: number, p: Profile) => {
    const row = pick([[5, 180, 120], [6, 180, 120], [5, 240, 150], [6, 240, 150], [5, 300, 180]], lvl, dur * 60 - 1500);
    return make('run', 'run.vo2', `VO2max ${setName(row)}`, 'vo2', true,
      assemble(dur, rWu(15), [strides(3), blk('VO2max', row[0], [S('work', row[1], 1.05, 1.12, { cue: 'Strong and even' }), S('recovery', row[2], 0.62, 0.7, { cue: 'Jog' })])], rCd(), rZ2),
      'Roughly 3–5 km race effort. Even splits; if the last rep is slower than the first you started too fast.', p);
  },

  long: (dur: number, lvl: number, p: Profile, phase: string, d: TriDistance) => {
    let main: Block[] = [];
    let desc = 'Long aerobic run. Even effort; let pace drift rather than power/HR climb.';
    const budget = dur * 60 - 1500;
    if (phase === 'build' && budget > 1500) {
      const secs = Math.min(600 + lvl * 300, 1800, budget - 600);
      main = [blk('Progression', 1, [S('work', secs, 0.88, 0.93, { cue: 'Steady finish' })])];
      desc = 'Progression long run: finish at steady effort on tired legs.';
    } else if ((phase === 'specific' || phase === 'taper') && budget > 1500) {
      const rp = { sprint: [0.98, 1.03], olympic: [0.95, 1], half: [0.89, 0.94], full: [0.8, 0.86] }[d];
      const row = pick([[2, 600, 180], [3, 600, 180], [3, 900, 180], [2, 1500, 240], [3, 1200, 180]], lvl, budget - 300);
      main = [blk('Race pace', row[0], [S('work', row[1], rp[0], rp[1], { cue: 'Goal race effort' }), S('recovery', row[2], 0.72, 0.8)])];
      desc = 'Long run with goal race-effort blocks in the second half. Practise fuelling exactly as on race day.';
    }
    return make('run', 'run.long', main.length ? `Long run · ${main[0].name.toLowerCase()}` : 'Long run', main.length ? 'tempo' : 'endurance', false,
      assemble(dur, rWu(10), main, rCd(5), rZ2, true), desc, p);
  },

  brick: (dur: number, lvl: number, p: Profile, phase: string, d: TriDistance) => {
    const rp = { sprint: [0.98, 1.03], olympic: [0.95, 1], half: [0.89, 0.94], full: [0.8, 0.86] }[d];
    const specific = phase === 'specific' || phase === 'taper';
    const fast = Math.min(dur - 5, specific ? 10 + lvl * 3 : 8) * 60;
    const blocks = specific
      ? [blk('Race pace', 1, [S('work', fast, rp[0], rp[1], { cue: 'Settle into race effort' })]), ...(dur * 60 - fast >= 60 ? [rCd(Math.round(dur - fast / 60))] : [])]
      : [blk('Off the bike', 1, [S('work', dur * 60, 0.8, 0.88, { cue: 'Quick cadence find rhythm' })])];
    return make('run', 'run.brick', specific ? 'Brick run · race pace' : 'Brick run', specific ? 'racepace' : 'endurance', specific,
      blocks, 'Straight off the bike (<5 min transition). The goal is finding run rhythm on cycling-fatigued legs, not volume.', p);
  },

  openers: (dur: number, _l: number, p: Profile) =>
    make('run', 'run.openers', 'Shake-out + strides', 'speed', false,
      [blk('Easy running', 1, [S('work', Math.max(dur - 8, 8) * 60, 0.76, 0.84)]), strides(4)],
      'Short and light. Four relaxed strides to stay sharp.', p),

  test: (_d: number, _l: number, p: Profile) =>
    make('run', 'run.test', 'Threshold test (30 min TT)', 'test', true, [
      rWu(15), strides(4),
      blk('Time trial', 1, [S('work', 1800, 0.97, 1.05, { cue: 'Best even solo effort' })]),
      rCd(10),
    ], 'Solo 30-min time trial on flat ground or track. Threshold power/pace ≈ the 30-min average; LTHR ≈ average HR of the final 20 min. Update thresholds afterwards.', p),
};

// ============================== SWIM ==============================
// Distances are in metres. `dur` sizes the session via CSS so volume scales with the athlete's speed.
function swimMeters(dur: number, p: Profile) {
  const css = p.cssSecPer100 || 100;
  return Math.max(1000, Math.round(((dur * 60) / css) * 100 * 0.8 / 100) * 100);
}
const sWu = (m: number) => blk('Warm-up', 1, [M('warmup', m, 0.78, 0.86, { cue: 'Easy mixed strokes' })]);
const sDrill = blk('Drills', 6, [M('work', 50, 0.8, 0.88, { cue: 'Drill half swim half' }), rest(15)]);
const sCd = (m: number) => blk('Cool-down', 1, [M('cooldown', m, 0.75, 0.82, { cue: 'Easy' })]);
const sMake = (code: string, name: string, cat: Category, hard: boolean, blocks: Block[], desc: string, p: Profile) => {
  const w = make('swim', code, name, cat, hard, blocks, desc, p);
  const m = measure(blocks, p).meters;
  return { ...w, name: `${name} · ${m} m`, notes: undefined };
};
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const swim = {
  technique: (dur: number, _l: number, p: Profile) => {
    const total = swimMeters(dur, p);
    const reps = clamp(Math.round((total - 800) / 200), 2, 12);
    return sMake('swim.technique', 'Technique + aerobic', 'technique', false, [
      sWu(300), sDrill,
      blk('Aerobic pull', reps, [M('work', 200, 0.87, 0.92, { cue: 'Pull buoy long strokes' }), rest(20)]),
      sCd(200),
    ], 'Stroke quality first: catch, body line, relaxed exhale. Pull sets build swim-specific strength without spiking HR.', p);
  },

  css: (dur: number, lvl: number, p: Profile) => {
    const total = swimMeters(dur, p);
    const mainM = total - 900;
    const variant = lvl % 3;
    const main = variant === 0
      ? blk('CSS hundreds', clamp(Math.round(mainM / 100), 8, 30), [M('work', 100, 0.98, 1.01, { cue: 'Hold CSS' }), rest(15)])
      : variant === 1
        ? blk('CSS two-hundreds', clamp(Math.round(mainM / 200), 4, 15), [M('work', 200, 0.97, 1, { cue: 'Hold CSS' }), rest(20)])
        : blk('CSS four-hundreds', clamp(Math.round(mainM / 400), 2, 8), [M('work', 400, 0.95, 0.99, { cue: 'Just under CSS' }), rest(30)]);
    return sMake('swim.css', 'CSS threshold', 'threshold', true, [
      sWu(400), blk('Build', 4, [M('work', 50, 0.9, 1.05, { cue: 'Build to fast', ramp: true }), rest(15)]), main, sCd(200),
    ], 'Critical swim speed set: short rests keep you at threshold. Use a tempo trainer or the pace clock; every rep the same split.', p);
  },

  speed: (dur: number, _l: number, p: Profile) => {
    const total = swimMeters(dur, p);
    const reps = clamp(Math.round((total - 1300) / 50), 8, 24);
    return sMake('swim.speed', 'VO2 + speed', 'vo2', true, [
      sWu(400), sDrill,
      blk('Fast fifties', reps, [M('work', 50, 1.05, 1.1, { cue: 'Fast strong catch' }), rest(30)]),
      blk('Sprints', 8, [M('work', 25, 1.15, 1.25, { cue: 'Max speed' }), rest(40)]),
      sCd(200),
    ], 'Above-CSS speed and race-start power. Full quality on every rep — take the rest.', p);
  },

  endurance: (dur: number, lvl: number, p: Profile, phase: string) => {
    const total = swimMeters(dur, p);
    const specific = phase === 'specific' || phase === 'taper' || phase === 'race';
    const unit = total >= 3400 ? 800 : total >= 2400 ? 600 : 400;
    const reps = clamp(Math.round((total - 700) / unit), 2, 6);
    return sMake('swim.endurance', specific ? 'Race-pace endurance' : 'Aerobic endurance', specific ? 'racepace' : 'endurance', specific, [
      sWu(400),
      ...(specific ? [blk('Race start', 4, [M('work', 50, 1.06, 1.12, { cue: 'Race start speed' }), rest(20)])] : []),
      blk(specific ? 'Race pace' : 'Aerobic', reps, [M('work', unit, specific ? 0.94 : 0.89, specific ? 0.98 : 0.94, { cue: specific ? 'Race effort sight every few strokes' : 'Steady aerobic' }), rest(30)]),
      sCd(200),
    ], specific
      ? 'Sustained race-effort swimming after a fast start, exactly as the race unfolds. Do it in open water in your wetsuit when you can; practise sighting and drafting.'
      : 'Continuous aerobic swimming with long reps. Count strokes; keep them constant as you tire.', p);
  },

  openers: (_d: number, _l: number, p: Profile) =>
    sMake('swim.openers', 'Pre-race swim', 'speed', false, [
      sWu(400), blk('Pick-ups', 6, [M('work', 50, 1, 1.08, { cue: 'Race pace' }), rest(30)]), sCd(200),
    ], 'Feel for the water and a few race-pace efforts. Out before you are tired.', p),

  test: (_d: number, _l: number, p: Profile) =>
    sMake('swim.test', 'CSS test (400 + 200)', 'test', true, [
      sWu(400), blk('Build', 4, [M('work', 50, 0.9, 1.05, { ramp: true, cue: 'Build' }), rest(20)]),
      blk('Time trial four hundred', 1, [M('work', 400, 1, 1.06, { cue: 'Best even effort' }), rest(480)]),
      blk('Time trial two hundred', 1, [M('work', 200, 1.03, 1.1, { cue: 'Best effort' })]),
      sCd(300),
    ], 'CSS pace per 100 m = (T400 − T200) / 2, in seconds. Update your CSS afterwards.', p),
};

// ============================== RACE ==============================
export const RACE_LOAD: Record<string, { tss: number; min: number }> = {
  sprint: { tss: 95, min: 70 }, olympic: { tss: 170, min: 140 }, half: { tss: 310, min: 300 }, full: { tss: 560, min: 660 },
  duathlonSprint: { tss: 90, min: 65 }, duathlon: { tss: 170, min: 125 }, aquathlon: { tss: 55, min: 35 },
  run10k: { tss: 70, min: 42 }, halfMarathon: { tss: 140, min: 95 }, marathon: { tss: 280, min: 200 },
  bikeEvent: { tss: 220, min: 210 }, other: { tss: 120, min: 100 },
};
export function raceWorkout(name: string, type: string, priority: string): Workout {
  const l = RACE_LOAD[type] ?? RACE_LOAD.other;
  return {
    sport: 'race', code: 'race', name: `${priority}-race: ${name}`, category: 'race', hard: true, blocks: [],
    description: priority === 'A' ? 'This is what the block was for. Execute the plan: pacing, fuelling, patience.'
      : priority === 'B' ? 'Race it properly, but it serves the A-race: test pacing, nutrition and transitions.'
        : 'Training race. Go hard, learn something, back to work.',
    durationMin: l.min, tss: l.tss,
  };
}
