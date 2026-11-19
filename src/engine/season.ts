// Season planner: periodises backwards from the A-races, inserts a return-to-training block,
// recovery and test weeks, then simulates fitness (CTL) forward to set each week's load target.
import type { Availability, Phase, Profile, Race, RaceType, SeasonWeek, TriDistance } from './types.ts';
import { addDays, diffDays, mondayOf } from './dates.ts';
import { RACE_LOAD } from './workouts.ts';
import { dayCap } from './defaults.ts';

const TRI: TriDistance[] = ['sprint', 'olympic', 'half', 'full'];
export function triDistance(t: RaceType | undefined): TriDistance {
  if (t && (TRI as string[]).includes(t)) return t as TriDistance;
  if (t === 'marathon' || t === 'bikeEvent') return 'half';
  // Sprint duathlon (5/20/2.5 km) and aquathlon are raced at sprint intensity; standard duathlon (10/40/5 km) like an Olympic.
  if (t === 'duathlonSprint' || t === 'aquathlon') return 'sprint';
  return 'olympic';
}

const TAPER: Record<TriDistance, number> = { sprint: 0, olympic: 1, half: 1, full: 2 };
const SPECIFIC: Record<TriDistance, number> = { sprint: 3, olympic: 4, half: 5, full: 6 };
const BUILD: Record<TriDistance, number> = { sprint: 5, olympic: 6, half: 6, full: 8 };

/** Weeks of low-intensity re-loading owed after a break of `weeksOff`. */
export function rebuildWeeks(weeksOff: number): number {
  if (weeksOff < 2) return 0;
  if (weeksOff < 4) return 2;
  if (weeksOff < 8) return 3;
  if (weeksOff < 16) return 4;
  return 6;
}

const RAMP = { conservative: 0.75, moderate: 1, aggressive: 1.3 };
// CTL points per week targeted in a loading week, and expected load density, per phase.
const PHASE_RAMP: Record<Phase, number> = { rebuild: 3, base: 4, build: 4, specific: 2.5, taper: 0, race: 0, transition: 0 };
const TSS_PER_HOUR: Record<Phase, number> = { rebuild: 48, base: 54, build: 60, specific: 62, taper: 60, race: 60, transition: 45 };

const FOCUS: Record<Phase, string> = {
  rebuild: 'Return to training: frequency before volume, volume before intensity. Aerobic work, strides, tendon and strength re-loading.',
  base: 'Aerobic base and muscular endurance: sweet spot, hills, long sessions, maximal strength.',
  build: 'Raise the ceiling and the threshold: VO2max and threshold work, durability in the long sessions.',
  specific: 'Race specificity: goal-pace work, bricks, race simulations, nutrition rehearsal.',
  taper: 'Taper: cut volume ~40–60%, keep frequency and intensity. Arrive fresh, not detrained.',
  race: 'Race week: openers, logistics, sleep. Nothing new.',
  transition: 'Transition: unstructured, low load. Recover physically and mentally before the next block.',
};

export interface SeasonInput {
  today: string;
  profile: Profile;
  availability: Availability;
  races: Race[];
  /** Current chronic training load; undefined -> estimated from recent weekly hours */
  ctl?: number;
}

export function weekCapacityHours(start: string, a: Availability, restDay = false): number {
  const mins: number[] = [];
  for (let d = 0; d < 7; d++) mins.push(dayCap(a, addDays(start, d), d));
  let total = mins.reduce((t, m) => t + m, 0);
  // A protected rest day removes the shortest day from usable capacity.
  if (a.fixed?.rest != null) total -= mins[a.fixed.rest];
  else if (restDay && mins.every((m) => m >= 30)) total -= Math.min(...mins);
  return total / 60;
}

export function buildSeason(input: SeasonInput): { weeks: SeasonWeek[]; warnings: string[] } {
  const { today, profile, availability } = input;
  const warnings: string[] = [];
  const start = mondayOf(today);
  const idx = (date: string) => Math.floor(diffDays(date, start) / 7);
  const races = input.races.filter((r) => r.date >= today).sort((a, b) => a.date.localeCompare(b.date));

  // Target races: all A-races; if none are marked, the highest-priority remaining race.
  let targets = races.filter((r) => r.priority === 'A');
  if (!targets.length && races.length) {
    const best = races.some((r) => r.priority === 'B') ? 'B' : 'C';
    targets = [races.filter((r) => r.priority === best).at(-1)!];
    warnings.push(`No A-race set — periodising towards “${targets[0].name}”. Mark your key race as priority A.`);
  }

  const lastRace = races.at(-1);
  const n = Math.min(60, lastRace ? idx(lastRace.date) + 2 : 16);
  const phases: (Phase | undefined)[] = new Array(n).fill(undefined);
  const targetOf: (Race | undefined)[] = new Array(n).fill(undefined);

  // 1. Return-to-training block (never skipped, only shortened by time already served).
  let cursor = 0;
  if (profile.comeback.active) {
    const from = profile.comeback.resumedOn ?? profile.comeback.planStart;
    const served = from ? Math.max(0, Math.floor(diffDays(start, from) / 7)) : 0;
    const owed = Math.max(0, rebuildWeeks(profile.comeback.weeksOff) - served);
    for (let i = 0; i < Math.min(owed, n); i++) phases[i] = 'rebuild';
    cursor = Math.min(owed, n);
  }

  // 2. Work backwards from each target race.
  for (const race of targets) {
    const ri = idx(race.date);
    if (ri >= n || ri < 0) continue;
    const d = triDistance(race.type);
    if (ri < cursor) {
      warnings.push(`“${race.name}” falls inside your return-to-training block. Treat it as a controlled training day, not a peak.`);
      phases[ri] = 'race'; targetOf[ri] = race;
      continue;
    }
    phases[ri] = 'race';
    let i = ri - 1;
    const fill = (phase: Phase, len: number) => {
      for (let k = 0; k < len && i >= cursor; k++, i--) phases[i] = phase;
    };
    const available = ri - cursor;
    fill('taper', TAPER[d]);
    fill('specific', SPECIFIC[d]);
    fill('build', BUILD[d]);
    fill('base', n);
    const ideal = TAPER[d] + SPECIFIC[d] + BUILD[d] + 4;
    if (available < ideal) {
      warnings.push(`${available} week${available === 1 ? '' : 's'} of structured training before “${race.name}” (ideal ≥ ${ideal}): base/build are compressed. Expect a solid race rather than a full peak.`);
    }
    for (let k = cursor; k <= ri; k++) targetOf[k] = race;
    // Transition after the race, unless another target is too close to afford it.
    const next = targets[targets.indexOf(race) + 1];
    const gap = next ? idx(next.date) - ri : 99;
    const trans = gap <= 3 ? 0 : d === 'full' ? 2 : 1;
    for (let k = 1; k <= trans && ri + k < n; k++) phases[ri + k] = 'transition';
    cursor = ri + 1 + trans;
  }

  // 3. No races (or time left after the last): general base -> build cycle.
  let cyc = 0;
  for (let i = 0; i < n; i++) {
    if (phases[i]) { if (phases[i] !== 'rebuild') cyc = 0; continue; }
    if (targets.length && i >= cursor) { phases[i] = 'transition'; continue; }
    phases[i] = cyc % 14 < 8 ? 'base' : 'build';
    cyc++;
  }

  // 4. Recovery and test weeks.
  const age = profile.birthYear ? +today.slice(0, 4) - profile.birthYear : 35;
  const cycle = profile.recoveryCycle === '2:1' ? 2 : profile.recoveryCycle === '3:1' ? 3 : age >= 45 ? 2 : 3;
  const weeks: SeasonWeek[] = [];
  let run = 0, loadIdx = 0, sinceTest = 99, prevPhase: Phase | undefined;
  for (let i = 0; i < n; i++) {
    const phase = phases[i]!;
    const wkStart = addDays(start, i * 7);
    const wkRaces = races.filter((r) => r.date >= wkStart && r.date <= addDays(wkStart, 6));
    if (phase !== prevPhase) loadIdx = 0;
    const loading = phase === 'rebuild' || phase === 'base' || phase === 'build' || phase === 'specific';
    const next = phases[i + 1];
    const cyc2 = phase === 'rebuild' ? Math.min(cycle, 2) : cycle;
    let recovery = false;
    if (loading) {
      const lastOfRebuild = phase === 'rebuild' && next !== 'rebuild';
      if (run >= cyc2 && next !== 'taper' && next !== 'race') recovery = true;
      // Finish the comeback block with a consolidation + test week to recalibrate thresholds.
      if (lastOfRebuild && run >= 1) recovery = true;
    }
    const hasSideRace = wkRaces.some((r) => r.priority !== 'A' && phase !== 'race');
    const testWeek = recovery && !hasSideRace && (sinceTest >= 5 || phase === 'rebuild');
    const target = targetOf[i] ?? targets.find((t) => t.date >= wkStart) ?? targets.at(-1);
    weeks.push({
      start: wkStart, phase, loadIdx, recovery, testWeek,
      targetTss: 0, targetHours: 0, ctlEnd: 0, races: wkRaces,
      targetRaceId: target?.id, targetType: triDistance(target?.type), targetRace: target?.type,
      focus: recovery ? `Recovery week${testWeek ? ' + threshold testing' : ''}: absorb the block. ${FOCUS[phase]}` : FOCUS[phase],
    });
    if (loading && !recovery) { run++; loadIdx++; } else run = 0;
    sinceTest = testWeek ? 0 : sinceTest + 1;
    prevPhase = phase;
  }

  // 5. Load targets via forward CTL simulation.
  let ctl = input.ctl ?? (profile.currentWeeklyHours * 52) / 7;
  const mult = profile.ramp === 'learned' ? Math.max(2, Math.min(7, profile.learnedRamp ?? 4)) / 4 : RAMP[profile.ramp];
  const decay = 1 - Math.exp(-7 / 42);
  let lastLoad = ctl * 7;
  for (const w of weeks) {
    const tph = TSS_PER_HOUR[w.phase];
    const capHours = Math.min(profile.maxWeeklyHours, weekCapacityHours(w.start, availability, profile.restDay) * 0.95);
    let tss: number;
    const raceTss = w.races.reduce((t, r) => t + (RACE_LOAD[r.type] ?? RACE_LOAD.other).tss, 0);
    if (w.phase === 'race') tss = ctl * 7 * 0.42 + raceTss;
    else if (w.phase === 'taper') tss = ctl * 7 * (weeks[weeks.indexOf(w) + 1]?.phase === 'race' ? 0.65 : 0.8);
    else if (w.phase === 'transition') tss = ctl * 7 * 0.35;
    else if (w.recovery) tss = Math.min(lastLoad, ctl * 7 * 1.15) * 0.62;
    else {
      // Daily load needed to lift a 42-day average by r points in a week ~= CTL + 6r.
      tss = 7 * (ctl + 6 * PHASE_RAMP[w.phase] * mult);
      if (w.races.some((r) => r.priority === 'B')) tss *= 0.82;
      lastLoad = tss;
    }
    const maxTss = capHours * tph + (w.phase === 'race' ? raceTss : 0);
    if (tss > maxTss) { tss = maxTss; if (!w.recovery && w.phase !== 'race') lastLoad = tss; }
    w.targetTss = Math.round(tss);
    w.targetHours = Math.round(((tss - (w.phase === 'race' ? raceTss : 0)) / tph) * 4) / 4;
    ctl += (tss / 7 - ctl) * decay;
    w.ctlEnd = Math.round(ctl * 10) / 10;
  }
  if (weeks.some((w) => !w.recovery && (w.phase === 'build' || w.phase === 'specific') && w.targetHours >= Math.min(profile.maxWeeklyHours, weekCapacityHours(w.start, availability, profile.restDay) * 0.95) - 0.3)) {
    warnings.push(availability.days.some((d) => d.minutes != null)
      ? 'Your daily limits or weekly maximum cap the plan in the build/specific phases. More time would allow further progression.'
      : 'Your weekly maximum caps the plan in the build/specific phases. A higher maximum would allow further progression.');
  }
  return { weeks, warnings };
}
