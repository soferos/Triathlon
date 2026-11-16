// Weekly scheduler: turns a season week (phase, load target) into dated, structured sessions that
// respect availability, pool/gym access, hard-day spacing and race logistics.
import type { Availability, Profile, Race, Role, SeasonWeek, Session, Sport, TriDistance, Workout } from './types.ts';
import { addDays, diffDays, DAY_NAMES } from './dates.ts';
import { bike, run, swim, raceWorkout } from './workouts.ts';
import { strengthBlockFor, strengthWorkout } from './strength.ts';

interface Spec {
  sport: Sport; role: Role; hard: boolean;
  /** Relative share of the discipline's weekly minutes, with hard floor/ceiling (min) */
  w: number; min: number; max: number;
  make: (dur: number) => Workout;
  dur: number;
  /** Must share a day with a bike session (brick) */
  afterBike?: boolean;
  day?: number;
  label: string;
}
interface Day { cap: number; used: number; specs: Spec[]; hard: boolean; pool: boolean; gym: boolean; blocked: boolean; noHard: boolean; long: boolean }

const SPLIT: Record<TriDistance, [number, number, number]> = {
  sprint: [0.22, 0.44, 0.34], olympic: [0.22, 0.45, 0.33], half: [0.2, 0.49, 0.31], full: [0.17, 0.53, 0.3],
};
const LONG_RIDE_MAX: Record<TriDistance, number> = { sprint: 150, olympic: 180, half: 240, full: 330 };
const LONG_RUN_MAX: Record<TriDistance, number> = { sprint: 80, olympic: 100, half: 120, full: 150 };
const r5 = (n: number) => Math.round(n / 5) * 5;

let seq = 0;
const newId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface WeekResult { sessions: Session[]; warnings: string[] }

/**
 * @param progress per-workout-type level offsets earned (or lost) through execution, e.g. { 'bike.vo2': 1 }
 */
export function buildWeek(week: SeasonWeek, profile: Profile, availability: Availability, progress: Record<string, number> = {}): WeekResult {
  const warnings: string[] = [];
  const p = profile;
  const d = week.targetType;
  const phase = week.phase;
  const lvl = week.loadIdx;
  const easyWeek = week.recovery || phase === 'transition';
  /** Progression level for one workout type: calendar position plus what execution has earned. */
  const L = (code: string, base = lvl) => Math.max(0, base + (progress[code] ?? 0));
  const course = week.course;
  const comeback = p.comeback.active;

  // ---------- days ----------
  const days: Day[] = availability.days.map((a, i) => {
    const o = availability.overrides[addDays(week.start, i)];
    return { cap: o ? o.minutes : a.minutes, used: 0, specs: [], hard: false, pool: a.pool, gym: a.gym, blocked: false, noHard: false, long: false };
  });
  const open = () => days.filter((x) => x.cap >= 30).length;
  if (p.restDay && open() === 7) {
    // Protect one full rest day: the day with the least time, preferring Monday then Friday.
    const order = [0, 4, 1, 2, 3, 5, 6];
    const rest = order.reduce((best, i) => (days[i].cap < days[best].cap ? i : best), order[0]);
    days[rest].blocked = true;
  }

  // ---------- races in this week ----------
  const fixed: { day: number; workout: Workout; race: Race }[] = [];
  let aRaceDay = -1;
  for (const r of week.races) {
    const di = diffDays(r.date, week.start);
    fixed.push({ day: di, workout: raceWorkout(r.name, r.type, r.priority), race: r });
    days[di].blocked = true;
    if (r.priority === 'A') {
      aRaceDay = di;
      for (let k = di + 1; k < 7; k++) days[k].blocked = true; // post-race: nothing scheduled
      if (di >= 2) days[di - 2].cap = Math.min(days[di - 2].cap, 40);
      for (let k = Math.max(0, di - 3); k < di; k++) days[k].noHard = k !== di - 3;
    } else {
      if (di > 0) days[di - 1].noHard = true;
      if (r.priority === 'B' && di > 1) days[di - 2].noHard = true;
      if (di < 6) { days[di + 1].noHard = true; days[di + 1].cap = Math.min(days[di + 1].cap, 60); }
    }
  }
  const sideRace = week.races.find((r) => r.priority !== 'A');

  // ---------- time budget ----------
  const hours = week.targetHours;
  let total = hours * 60;
  const poolDays = days.filter((x) => x.pool && !x.blocked && x.cap >= 30).length;
  let nStrength = phase === 'race' ? 0 : phase === 'specific' || phase === 'taper' || easyWeek ? 1 : hours < 7 ? 1 : 2;
  if (phase === 'taper' && week.loadIdx === 0 && d === 'sprint') nStrength = 0;
  const strengthMin = phase === 'specific' || phase === 'taper' ? 35 : 45;
  total -= nStrength * strengthMin;

  let [fs, fb, fr] = SPLIT[d];
  if (p.limiter !== 'none') {
    const bump = 0.05;
    const f = { swim: fs, bike: fb, run: fr };
    const others = (['swim', 'bike', 'run'] as const).filter((k) => k !== p.limiter);
    f[p.limiter] += bump;
    for (const k of others) f[k] -= bump / 2;
    [fs, fb, fr] = [f.swim, f.bike, f.run];
  }
  if (phase === 'rebuild') { fb += fr * 0.15; fr *= 0.85; } // re-load impact tolerance gradually
  // Two-discipline targets: in the specific block, taper and race week the missing discipline drops
  // to maintenance and its time goes to the two that are raced. Earlier phases stay full triathlon.
  const closing = phase === 'specific' || phase === 'taper' || phase === 'race';
  const duathlon = closing && (week.targetRace === 'duathlon' || week.targetRace === 'duathlonSprint');
  const aquathlon = closing && week.targetRace === 'aquathlon';
  if (duathlon) { const cut = fs * 0.6; fs -= cut; fr += cut; } // run-bike-run: the freed swim time goes to running
  if (aquathlon) { const cut = fb * 0.4; fb -= cut; fs += cut * 0.4; fr += cut * 0.6; }
  let nSwim = hours < 7 ? 2 : hours < 12 ? 3 : 4;
  if (phase === 'race') nSwim = duathlon ? 0 : 2;
  else if (duathlon) nSwim = Math.min(nSwim, 1);
  if (phase === 'transition') nSwim = 1;
  nSwim = Math.min(nSwim, poolDays, Math.max(1, Math.floor((total * fs) / 30)));
  if (poolDays === 0 && nSwim === 0 && duathlon) { fr += fs; fs = 0; }
  else if (poolDays === 0) {
    nSwim = 0;
    warnings.push(`Week of ${week.start}: no pool access on any available day — swim time moved to bike/run.`);
    fb += fs * 0.6; fr += fs * 0.4; fs = 0;
  }
  let nBike = hours < 6 ? 2 : hours < 10.5 ? 3 : hours < 15 ? 4 : 5;
  let nRun = hours < 6 ? 3 : hours < 10.5 ? 4 : 5;
  if (phase === 'rebuild') nRun = Math.max(3, nRun - (lvl === 0 ? 1 : 0));
  if (phase === 'race') { nBike = 2; nRun = 2; }
  if (phase === 'transition') { nBike = 2; nRun = 2; }

  // ---------- session menu ----------
  const specs: Spec[] = [];
  const add = (sport: Sport, role: Role, label: string, hard: boolean, w: number, min: number, max: number, make: Spec['make'], x: Partial<Spec> = {}) =>
    specs.push({ sport, role, label, hard, w, min, max, make, dur: 0, ...x });

  const longRideMax = phase === 'rebuild' ? 150 : phase === 'taper' ? LONG_RIDE_MAX[d] * 0.6 : LONG_RIDE_MAX[d];
  const longRunMax = phase === 'rebuild' ? 75 : phase === 'taper' ? LONG_RUN_MAX[d] * 0.65 : LONG_RUN_MAX[d];
  const longCourse = d === 'half' || d === 'full';
  const altWeek = lvl % 2 === 1;
  // Hard sessions allowed this week (rebuild introduces intensity gradually).
  const intensityOK = phase !== 'rebuild' || lvl >= 1;

  // --- bike ---
  const bikeSpecs: [Role, string, boolean, number, number, number, Spec['make']][] = [];
  if (phase === 'race') {
    bikeSpecs.push(['key', 'Race-pace primer', false, 1.2, 40, 60, (m) => bike.racepace(m, 0, p, d)]);
    bikeSpecs.push(['opener', 'Openers', false, 0.8, 25, 40, (m) => bike.openers(m, 0, p)]);
  } else if (easyWeek) {
    if (week.testWeek) bikeSpecs.push(['test', 'FTP test', true, 1.2, 60, 65, (m) => bike.test(m, 0, p)]);
    bikeSpecs.push(['long', 'Long ride', false, 2, 60, longRideMax * 0.7, (m) => bike.long(m, 0, p, 'rebuild', d)]);
    for (let i = bikeSpecs.length; i < nBike - 1; i++) bikeSpecs.push(['easy', 'Endurance', false, 1, 40, 75, (m) => bike.endurance(m, 0, p)]);
  } else {
    bikeSpecs.push(['long', 'Long ride', false, 3, 75, longRideMax, (m) => bike.long(m, lvl, p, phase, d)]);
    if (phase === 'rebuild') {
      if (intensityOK) bikeSpecs.push(['key', 'Sweet spot (intro)', true, 1.3, 55, 75, (m) => bike.sweetspot(m, Math.max(0, lvl - 1), p)]);
    } else if (phase === 'base') {
      bikeSpecs.push(['key', 'Sweet spot', true, 1.4, 60, 100, (m) => bike.sweetspot(m, L('bike.sweetspot'), p)]);
      if (nBike >= 4) bikeSpecs.push(altWeek
        ? ['key', 'VO2 touch', true, 1.2, 60, 75, (m) => bike.vo2(m, 0, p)]
        : ['easy', 'Endurance + sprints', false, 1.2, 60, 90, (m) => bike.endurance(m, 1, p)]);
    } else if (phase === 'build') {
      if (longCourse) {
        bikeSpecs.push(['key', 'Threshold', true, 1.4, 65, 100, (m) => (altWeek ? bike.overunder(m, L('bike.overunder'), p) : bike.threshold(m, L('bike.threshold'), p))]);
        bikeSpecs.push(['key', 'VO2max', true, 1.3, 60, 80, (m) => bike.vo2(m, L('bike.vo2'), p)]);
      } else {
        bikeSpecs.push(['key', 'VO2max', true, 1.3, 60, 80, (m) => bike.vo2(m, L('bike.vo2'), p)]);
        bikeSpecs.push(['key', 'Threshold', true, 1.4, 65, 95, (m) => (altWeek ? bike.overunder(m, L('bike.overunder'), p) : bike.threshold(m, L('bike.threshold'), p))]);
      }
    } else if (phase === 'specific') {
      bikeSpecs.push(['key', 'Race pace', true, 1.6, 70, longCourse ? 150 : 100, (m) => (course ? bike.course(m, L('bike.course'), p, d, course) : bike.racepace(m, L('bike.racepace'), p, d))]);
      bikeSpecs.push(['key', longCourse ? 'Threshold' : 'VO2max', true, 1.3, 60, 85, (m) => (longCourse ? bike.threshold(m, L('bike.threshold', 2 + lvl), p) : bike.vo2(m, L('bike.vo2', 2 + lvl), p))]);
    } else if (phase === 'taper') {
      bikeSpecs.push(['key', 'Race pace (short)', true, 1.4, 55, 80, (m) => bike.racepace(m, 1, p, d)]);
    }
    while (bikeSpecs.length > nBike) bikeSpecs.pop();
    for (let i = bikeSpecs.length; i < nBike; i++) bikeSpecs.push(['easy', 'Endurance', false, 1, 45, 90, (m) => bike.endurance(m, 0, p)]);
  }
  for (const [role, label, hard, w, min, max, make] of bikeSpecs) add('bike', role, label, hard, w, min, max, make);

  // --- run ---
  const runSpecs: [Role, string, boolean, number, number, number, Spec['make'], Partial<Spec>?][] = [];
  if (phase === 'race') {
    runSpecs.push(['easy', 'Easy + strides', false, 1.2, 25, 40, (m) => run.easy(m, 0, p)]);
    runSpecs.push(['opener', 'Shake-out', false, 0.8, 15, 25, (m) => run.openers(m, 0, p)]);
  } else if (easyWeek) {
    if (week.testWeek) runSpecs.push(['test', 'Run threshold test', true, 1.3, 60, 65, (m) => run.test(m, 0, p)]);
    runSpecs.push(['long', 'Long run', false, 1.8, 45, longRunMax * 0.7, (m) => run.long(m, 0, p, 'rebuild', d)]);
    for (let i = runSpecs.length; i < nRun - 1; i++) runSpecs.push(['easy', 'Easy run', false, 1, 30, 50, (m) => run.easy(m, 0, p)]);
  } else {
    runSpecs.push(['long', 'Long run', false, 2.3, 50, longRunMax, (m) => run.long(m, lvl, p, phase, d)]);
    if (phase === 'rebuild') {
      // strides only; run intensity returns last because impact tolerance lags aerobic fitness
    } else if (phase === 'base') {
      runSpecs.push(['key', lvl < 3 ? 'Hill reps' : 'Tempo', true, 1.4, 50, 75, (m) => (lvl < 3 ? run.hills(m, L('run.hills'), p) : run.tempo(m, L('run.tempo', lvl - 3), p))]);
    } else if (phase === 'build') {
      runSpecs.push(['key', 'Threshold', true, 1.4, 55, 80, (m) => run.threshold(m, L('run.threshold'), p)]);
      if (nRun >= 5 && !longCourse) runSpecs.push(['key', 'VO2max', true, 1.3, 55, 70, (m) => run.vo2(m, L('run.vo2'), p)]);
    } else if (phase === 'specific') {
      runSpecs.push(['key', longCourse ? 'Threshold' : 'VO2max', true, 1.4, 55, 80, (m) => (course?.runHilly && altWeek ? run.hills(m, L('run.hills', 1 + lvl), p) : longCourse ? run.threshold(m, L('run.threshold', 2 + lvl), p) : run.vo2(m, L('run.vo2', 1 + lvl), p))]);
    } else if (phase === 'taper') {
      runSpecs.push(['key', 'Threshold (short)', true, 1.3, 45, 60, (m) => run.threshold(m, 1, p)]);
    }
    if ((phase === 'build' || phase === 'specific' || phase === 'taper') && nRun >= 4) {
      runSpecs.push(['brick', 'Brick run', phase !== 'build', 0.6, 15, phase === 'build' ? 25 : 35, (m) => run.brick(m, lvl, p, phase, d), { afterBike: true }]);
    }
    while (runSpecs.length > nRun) runSpecs.pop();
    for (let i = runSpecs.length; i < nRun; i++) runSpecs.push(['easy', 'Easy run', false, 1, 30, 60, (m) => run.easy(m, phase === 'rebuild' && lvl === 0 ? -1 : 0, p)]);
  }
  for (const [role, label, hard, w, min, max, make, x] of runSpecs) add('run', role, label, hard, w, min, max, make, x);

  // --- swim ---
  for (let i = 0; i < nSwim; i++) {
    const hardOK = intensityOK && !easyWeek;
    if (phase === 'race') {
      add('swim', i === 0 ? 'key' : 'opener', i === 0 ? 'Race-pace swim' : 'Pre-race swim', false, 1, 25, 45,
        i === 0 ? (m) => swim.endurance(m, 0, p, 'race') : (m) => swim.openers(m, 0, p));
    } else if (week.testWeek && i === 0) {
      add('swim', 'test', 'CSS test', true, 1, 45, 55, (m) => swim.test(m, 0, p));
    } else if (i === 0 && hardOK) {
      add('swim', 'key', 'CSS threshold', true, 1.2, 35, 75, (m) => swim.css(m, L('swim.css'), p));
    } else if (i === 1) {
      add('swim', 'easy', 'Swim endurance', false, 1.1, 30, 80, (m) => swim.endurance(m, lvl, p, easyWeek ? 'base' : phase));
    } else if (i === 2 && hardOK && phase !== 'base') {
      add('swim', 'key', 'Swim speed', true, 1, 35, 60, (m) => swim.speed(m, lvl, p));
    } else {
      add('swim', 'easy', 'Swim technique', false, 1, 30, 60, (m) => swim.technique(m, lvl, p));
    }
  }

  // A B/C race replaces a key session of the week rather than being stacked on top.
  if (sideRace) {
    const sport: Sport = sideRace.type === 'run10k' || sideRace.type === 'halfMarathon' || sideRace.type === 'marathon' || sideRace.type === 'aquathlon' ? 'run' : 'bike';
    const i = specs.findIndex((s) => s.role === 'key' && s.sport === sport);
    if (i >= 0) specs.splice(i, 1);
    if (sideRace.priority === 'B') {
      const j = specs.findIndex((s) => s.role === 'key' && s.hard && s.sport !== 'swim');
      if (j >= 0) specs.splice(j, 1);
    }
  }

  // A duathlon block keeps one short maintenance swim, not a full session.
  if (duathlon) for (const sp of specs) if (sp.sport === 'swim') sp.max = Math.min(sp.max, 45);
  // The raced disciplines may run longer than their triathlon ceilings to take up the freed time
  // (a duathlon has two runs; an aquathlon is decided on the run).
  if (duathlon || aquathlon) {
    for (const sp of specs) {
      if (sp.role === 'brick' || sp.role === 'opener' || sp.hard) continue; // interval sessions keep their length
      if (sp.sport === 'run' || (aquathlon && sp.sport === 'swim')) sp.max = Math.round(sp.max * 1.25);
    }
  }

  // ---------- durations ----------
  for (const [sport, frac] of [['swim', fs], ['bike', fb], ['run', fr]] as [Sport, number][]) {
    const list = specs.filter((s) => s.sport === sport);
    const minutes = total * frac;
    const sum = list.reduce((t, s) => t + s.w, 0) || 1;
    for (const s of list) s.dur = Math.max(s.min, Math.min(s.max, r5((minutes * s.w) / sum)));
    // Hand back time clipped by ceilings to the sessions that can still absorb it.
    let spare = minutes - list.reduce((t, s) => t + s.dur, 0);
    for (const s of [...list].sort((a, b) => b.w - a.w)) {
      if (spare < 5) break;
      const extra = Math.min(r5(spare), s.max - s.dur);
      if (extra >= 5) { s.dur += extra; spare -= extra; }
    }
  }

  // ---------- placement ----------
  const cnt = (day: Day) => day.specs.filter((x) => x.sport !== 'strength').length;
  const neighbours = (i: number) => [days[i - 1], days[i + 1]].filter(Boolean);
  const score = (i: number, s: Spec): number => {
    const day = days[i];
    if (day.blocked) return -Infinity;
    const remaining = day.cap - day.used;
    if (remaining < s.min) return -Infinity;
    if (s.afterBike) {
      const b = day.specs.find((x) => x.sport === 'bike' && (x.role === 'long' || x.label.startsWith('Race pace')));
      return b && !day.specs.some((x) => x.sport === 'run') ? 100 + (b.role === 'long' ? (phase === 'build' ? 5 : 0) : 5) : -Infinity;
    }
    if (day.specs.some((x) => x.sport === s.sport)) return -Infinity;
    if (cnt(day) >= (day.cap >= 240 ? 3 : 2)) return -Infinity;
    if (s.sport === 'swim' && !day.pool) return -Infinity;
    if (s.hard && day.noHard) return -Infinity;
    let sc = (Math.min(s.dur, remaining) / s.dur) * 10;
    if (s.role === 'long') {
      sc += day.cap / 60 + (s.sport === 'bike' ? (i === 5 ? 0.6 : i === 6 ? 0.3 : 0) : i === 6 ? 0.5 : 0);
      if (day.long) sc -= 6;
      if (day.hard) sc -= 3;
      if (s.sport === 'run' && days[i - 1]?.hard) sc -= 1;
    } else if (s.hard) {
      if (day.hard) sc -= 9;
      if (day.long) sc -= 6;
      sc -= neighbours(i).filter((x) => x.hard).length * 4;
      if (s.sport === 'run' && days[i + 1]?.specs.some((x) => x.role === 'long' && x.sport === 'run')) sc -= 3;
      if (s.role === 'test') sc += neighbours(i).some((x) => x.long) ? -2 : 0;
      sc -= cnt(day) * 1.5;
    } else if (s.sport === 'swim') {
      sc -= cnt(day) * 1.2;
      sc -= neighbours(i).filter((x) => x.specs.some((y) => y.sport === 'swim')).length * 1.5;
    } else {
      sc -= day.used / 30;
      if (days[i - 1]?.hard) sc += 1;
      if (s.role === 'opener') sc += aRaceDay >= 0 && i === aRaceDay - 1 ? 50 : 0;
    }
    return sc;
  };
  const put = (s: Spec, i: number) => {
    const day = days[i];
    s.dur = Math.max(s.min, Math.floor(Math.min(s.dur, day.cap - day.used) / 5) * 5);
    s.day = i;
    day.used += s.dur;
    day.specs.push(s);
    if (s.hard && s.role !== 'brick') day.hard = true;
    if (s.role === 'long') day.long = true;
  };
  const place = (s: Spec) => {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < 7; i++) {
      const sc = score(i, s);
      if (sc > bestScore) { best = i; bestScore = sc; }
    }
    if (best < 0) {
      if (!s.afterBike) warnings.push(`Week of ${week.start}: no room for “${s.label}” (${s.sport}) — add availability${s.sport === 'swim' ? ' or pool access' : ''} to fit it.`);
      return;
    }
    put(s, best);
  };
  const placed = new Set<Spec>();
  const runPass = (order: ((s: Spec) => boolean)[]) => {
    for (const sel of order) for (const s of specs) if (!placed.has(s) && sel(s)) { placed.add(s); place(s); }
  };
  // Pass 1: the sessions that define the week.
  runPass([
    (s) => s.role === 'opener',
    (s) => s.role === 'long' && s.sport === 'bike',
    (s) => s.role === 'long' && s.sport === 'run',
    (s) => s.role === 'test',
    (s) => s.role === 'key' && s.sport !== 'swim',
    (s) => s.role === 'key',
    (s) => s.role === 'brick',
  ]);

  // --- strength: consolidate onto a hard day when possible, never the day before a key run or race ---
  const block = strengthBlockFor(phase, lvl, comeback);
  for (let k = 0; k < nStrength; k++) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < 7; i++) {
      const day = days[i];
      if (day.blocked || day.cap - day.used < 30 || day.specs.some((x) => x.sport === 'strength')) continue;
      if (p.strengthEquipment === 'gym' && !day.gym) continue;
      if (cnt(day) >= 3) continue;
      const nextDay = days[i + 1];
      if (aRaceDay >= 0 && aRaceDay - i <= 3) continue;
      if (fixed.some((f) => f.day === i + 1)) continue;
      let sc = 0;
      if (day.hard) sc += day.specs.some((x) => x.hard && x.sport === 'bike') ? 3 : 1.5;
      if (day.long) sc -= 4;
      if (nextDay?.specs.some((x) => x.sport === 'run' && (x.hard || x.role === 'long'))) sc -= 4;
      if (nextDay?.hard) sc -= 1.5;
      if (neighbours(i).some((x) => x.specs.some((y) => y.sport === 'strength'))) sc -= 6;
      sc -= cnt(day) * 0.8;
      if (sc > bestScore) { best = i; bestScore = sc; }
    }
    if (best < 0) {
      warnings.push(`Week of ${week.start}: no suitable day for strength session ${k + 1}${p.strengthEquipment === 'gym' ? ' — mark gym access on more days' : ''}.`);
      break;
    }
    const variant = k === 0 ? 'A' : 'B';
    const dur = Math.max(30, Math.min(strengthMin, Math.floor((days[best].cap - days[best].used) / 5) * 5));
    put({ sport: 'strength', role: 'strength', hard: false, w: 0, min: 30, max: 60, dur, label: 'Strength', make: (m) => strengthWorkout(block, variant, p, m) }, best);
  }

  // Pass 2: supporting aerobic volume fills what is left.
  // With a two-discipline target the runs claim the remaining days before the easy rides do.
  runPass([(s) => s.sport === 'swim', (s) => (duathlon || aquathlon) && s.role === 'easy' && s.sport === 'run', (s) => s.role === 'easy']);

  // Top up: if clipping or dropped sessions left the week short, extend long/easy sessions where the day allows.
  let deficit = hours * 60 - days.reduce((t, x) => t + x.used, 0);
  const stretch = specs.filter((s) => s.day != null && !s.hard && s.role !== 'opener' && s.role !== 'brick')
    .sort((a, b) => (a.role === 'long' ? 0 : 1) - (b.role === 'long' ? 0 : 1));
  // First give time back to the discipline it was budgeted for; then, for a full triathlon week,
  // let any discipline absorb what is still missing. Two-discipline targets skip the second pass
  // so the reduced discipline is not quietly topped back up.
  const budget: Record<string, number> = { swim: total * fs, bike: total * fb, run: total * fr };
  const placedIn = (sport: string) => specs.filter((x) => x.day != null && x.sport === sport).reduce((t, x) => t + x.dur, 0);
  for (const pass of duathlon || aquathlon ? ['budget'] : ['budget', 'any']) {
    for (const s of stretch) {
      if (deficit < 10) break;
      const day = days[s.day!];
      const room = pass === 'budget' ? (budget[s.sport] ?? 0) - placedIn(s.sport) : Infinity;
      const extra = Math.floor(Math.min(deficit, room, s.max - s.dur, day.cap - day.used) / 5) * 5;
      if (extra >= 5) { s.dur += extra; day.used += extra; deficit -= extra; }
    }
  }
  if (deficit > hours * 60 * 0.12 && phase !== 'race') {
    warnings.push(`Week of ${week.start}: availability fits ${((hours * 60 - deficit) / 60).toFixed(1)} h of the ${hours} h target — add time on some days to hit the planned load.`);
  }

  // ---------- emit ----------
  const sessions: Session[] = [];
  const rank = (s: Spec) => (s.sport === 'swim' ? 0 : s.sport === 'bike' ? 1 : s.sport === 'run' ? (s.afterBike ? 2 : 1.5) : 3);
  for (const f of fixed) {
    sessions.push({ id: newId(), date: addDays(week.start, f.day), sport: 'race', role: 'race', workout: f.workout, status: 'planned', locked: false, origin: 'plan' });
  }
  // Hot race: use the easy sessions of the final three weeks for heat acclimation (10-14 days is enough).
  const heat = !!course?.hot && week.weeksOut != null && week.weeksOut >= 1 && week.weeksOut <= 3;
  days.forEach((day, i) => {
    for (const s of [...day.specs].sort((a, b) => rank(a) - rank(b))) {
      const workout = s.make(s.dur);
      if (heat && !workout.hard && (s.sport === 'bike' || s.sport === 'run') && s.role !== 'opener') {
        workout.notes = `${workout.notes ?? ''} Heat acclimation: do this one hot — midday, overdressed, or indoors without a fan — or add 20–30 min of sauna or a hot bath straight after. Keep it easy, expect heart rate 5–10 bpm higher, and replace fluid and sodium.`.trim();
      }
      sessions.push({ id: newId(), date: addDays(week.start, i), sport: s.sport, role: s.role, workout, status: 'planned', locked: false, origin: 'plan' });
    }
  });
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  return { sessions, warnings };
}

export const dayLabel = (iso: string, weekStart: string) => DAY_NAMES[diffDays(iso, weekStart)];
