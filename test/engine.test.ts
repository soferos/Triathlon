import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeason, rebuildWeeks } from '../src/engine/season.ts';
import { buildWeek } from '../src/engine/week.ts';
import { defaultAvailability, defaultProfile } from '../src/engine/defaults.ts';
import { finalize, targetLabel, toIcuText } from '../src/engine/zones.ts';
import { bike, run, swim } from '../src/engine/workouts.ts';
import { assessReadiness } from '../src/engine/readiness.ts';
import { applyReadiness, customWorkout, emptyState, generate, reconcile } from '../src/engine/plan.ts';
import { addDays, diffDays, dow, mondayOf } from '../src/engine/dates.ts';
import type { Profile, Race, Wellness } from '../src/engine/types.ts';

const profile = (): Profile => ({ ...defaultProfile(), ftp: 280, runPower: 340, runPaceSecPerKm: 235, cssSecPer100: 92, birthYear: 1990 });
const races: Race[] = [
  { id: 'b', name: 'Spring Olympic', date: '2027-05-16', type: 'olympic', priority: 'B' },
  { id: 'a', name: 'Main 70.3', date: '2027-06-27', type: 'half', priority: 'A' },
];
const TODAY = '2026-11-11';

test('dates: Monday-based weeks', () => {
  assert.equal(mondayOf('2026-11-11'), '2026-11-09');
  assert.equal(dow('2026-11-15'), 6);
  assert.equal(diffDays(addDays('2027-03-27', 3), '2027-03-27'), 3); // across DST
});

test('season: periodises backwards from the A-race with a comeback block first', () => {
  const { weeks } = buildSeason({ today: TODAY, profile: profile(), availability: defaultAvailability(), races, ctl: 38 });
  const phases = weeks.map((w) => w.phase);
  assert.equal(weeks[0].start, '2026-11-09');
  assert.equal(phases[0], 'rebuild');
  assert.equal(phases.filter((x) => x === 'rebuild').length, rebuildWeeks(8));
  const raceIdx = weeks.findIndex((w) => w.races.some((r) => r.id === 'a'));
  assert.equal(phases[raceIdx], 'race');
  assert.equal(phases[raceIdx - 1], 'taper');
  assert.equal(phases[raceIdx - 2], 'specific');
  assert.equal(phases[raceIdx + 1], 'transition');
  // order of first appearance
  const order = [...new Set(phases)];
  assert.deepEqual(order, ['rebuild', 'base', 'build', 'specific', 'taper', 'race', 'transition']);
});

test('season: load ramps within limits, recovery weeks deload, taper sheds fatigue', () => {
  const { weeks } = buildSeason({ today: TODAY, profile: profile(), availability: defaultAvailability(), races, ctl: 38 });
  let prevCtl = 38, consecutiveLoad = 0;
  for (const w of weeks) {
    assert.ok(w.ctlEnd - prevCtl <= 5.5, `ramp too steep in ${w.start}: ${prevCtl} -> ${w.ctlEnd}`);
    assert.ok(w.targetHours <= profile().maxWeeklyHours + 0.01);
    if (w.recovery || !['rebuild', 'base', 'build', 'specific'].includes(w.phase)) consecutiveLoad = 0; else consecutiveLoad++;
    assert.ok(consecutiveLoad <= 4, 'no more than 4 loading weeks in a row');
    prevCtl = w.ctlEnd;
  }
  const rec = weeks.findIndex((w) => w.recovery && w.phase === 'base');
  assert.ok(weeks[rec].targetTss < weeks[rec - 1].targetTss * 0.7);
  assert.ok(weeks.some((w) => w.testWeek), 'has threshold test weeks');
  const taper = weeks.find((w) => w.phase === 'taper')!;
  const lastSpecific = weeks[weeks.indexOf(taper) - 1];
  assert.ok(taper.targetTss < lastSpecific.targetTss * 0.7);
});

test('season: warns when there is too little time, and works with no races', () => {
  const soon: Race[] = [{ id: 'x', name: 'Soon', date: addDays(TODAY, 40), type: 'half', priority: 'A' }];
  const a = buildSeason({ today: TODAY, profile: profile(), availability: defaultAvailability(), races: soon, ctl: 60 });
  assert.ok(a.warnings.some((w) => w.includes('compressed')));
  const none = buildSeason({ today: TODAY, profile: { ...profile(), comeback: { active: false, weeksOff: 0 } }, availability: defaultAvailability(), races: [] });
  assert.equal(none.weeks.length, 16);
  assert.equal(none.weeks[0].phase, 'base');
});

/** A working athlete's week with explicit daily limits and weekday-only pool/gym access. */
const limited = () => ({
  days: [60, 90, 120, 90, 60, 300, 180].map((minutes, i) => ({ minutes, pool: i < 5, gym: i < 5 })),
  overrides: {} as Record<string, { minutes: number; note?: string }>,
});

test('week: respects availability, pool access, rest day and hard-day rules across the season', () => {
  const p = profile(), a = limited();
  a.overrides['2027-02-03'] = { minutes: 0, note: 'travel' };
  const { weeks } = buildSeason({ today: TODAY, profile: p, availability: a, races, ctl: 38 });
  for (const w of weeks) {
    const { sessions } = buildWeek(w, p, a);
    assert.ok(sessions.length > 0, `week ${w.start} has sessions`);
    const byDay = new Map<string, typeof sessions>();
    for (const s of sessions) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
    for (const [date, list] of byDay) {
      const d = dow(date);
      const cap = a.overrides[date]?.minutes ?? a.days[d].minutes;
      const used = list.filter((s) => s.sport !== 'race').reduce((t, s) => t + s.workout.durationMin, 0);
      assert.ok(used <= cap + 10, `${date}: ${used} min scheduled in ${cap} min`);
      for (const s of list) if (s.sport === 'swim') assert.ok(a.days[d].pool, `${date}: swim on a non-pool day`);
      const sports = list.map((s) => s.sport);
      assert.equal(new Set(sports).size, sports.length, `${date}: duplicate sport`);
    }
    assert.ok(!byDay.has('2027-02-03'), 'override day stays empty');
    if (w.phase !== 'race' && w.start !== '2027-02-01') assert.ok(!byDay.has(w.start), 'Monday is the protected rest day');
    if (w.phase === 'rebuild' && w.loadIdx === 0) assert.ok(sessions.every((s) => !s.workout.hard), 'no intensity in the first week back');
    if (w.recovery) assert.ok(sessions.every((s) => !s.workout.hard || s.role === 'test' || s.role === 'race'), 'recovery week is easy');
    if (['base', 'build', 'specific'].includes(w.phase) && !w.recovery) {
      const tss = sessions.reduce((t, s) => t + s.workout.tss, 0);
      assert.ok(Math.abs(tss - w.targetTss) / w.targetTss < 0.25, `${w.start} ${w.phase}: planned ${tss} vs target ${w.targetTss}`);
      assert.ok(sessions.some((s) => s.role === 'long' && s.sport === 'bike') && sessions.some((s) => s.role === 'long' && s.sport === 'run'));
      assert.ok(sessions.some((s) => s.sport === 'strength'), `${w.start}: strength scheduled`);
    }
  }
});

test('week: A-race week tapers into the race and leaves the days after empty', () => {
  const p = profile(), a = defaultAvailability();
  const { weeks } = buildSeason({ today: TODAY, profile: p, availability: a, races, ctl: 38 });
  const wk = weeks.find((w) => w.phase === 'race')!;
  const { sessions } = buildWeek(wk, p, a);
  const race = sessions.find((s) => s.sport === 'race')!;
  assert.equal(race.date, '2027-06-27');
  assert.ok(sessions.every((s) => s.date <= race.date));
  const dayBefore = sessions.filter((s) => s.date === addDays(race.date, -1));
  assert.ok(dayBefore.length > 0 && dayBefore.every((s) => s.role === 'opener'));
  assert.ok(!sessions.some((s) => s.sport === 'strength'));
});

test('workouts: structure, load and absolute targets', () => {
  const p = profile();
  const w = bike.threshold(75, 3, p);
  assert.ok(Math.abs(w.durationMin - 75) <= 5);
  assert.ok(w.tss > 60 && w.tss < 95, `tss ${w.tss}`);
  const work = w.blocks.find((b) => b.name === 'Threshold')!.steps[0];
  assert.equal(targetLabel('bike', work, p), '269–286 W');
  assert.equal(targetLabel('run', { kind: 'work', secs: 60, lo: 0.97, hi: 1.02 }, p), '330–347 W');
  assert.equal(targetLabel('run', { kind: 'work', secs: 60, lo: 1, hi: 1 }, { ...p, runTarget: 'pace' }), '3:55 /km');
  assert.equal(targetLabel('swim', { kind: 'work', meters: 100, lo: 1, hi: 1 }, p), '1:32 /100m');
  assert.equal(targetLabel('bike', work, { ...p, ftp: undefined }), '96-102% FTP');
  const s = swim.css(60, 0, p);
  assert.ok(s.name.includes(' m'));
  assert.ok(Math.abs(s.durationMin - 60) <= 8, `swim duration ${s.durationMin}`);
});

test('intervals.icu text: power, pace, HR and swim distance syntax', () => {
  const p = profile();
  const t = toIcuText(bike.vo2(70, 1, p), p);
  assert.match(t, /^Warm-up\n- 15m ramp 50-72%$/m);
  assert.match(t, /^VO2max 5x\n- Hard start then hold 4m 110-118% 100rpm\n- 3m30s 45-55%$/m);
  const r = toIcuText(run.threshold(60, 0, { ...p, runTarget: 'pace' }), { ...p, runTarget: 'pace' });
  assert.match(r, /^Threshold 5x\n- Threshold not faster 5m 97-102% Pace\n- Jog 1m 65-72% Pace$/m);
  const h = toIcuText(bike.sweetspot(60, 0, { ...p, bikeTarget: 'hr' }), { ...p, bikeTarget: 'hr' });
  assert.match(h, /% LTHR$/m);
  const s = toIcuText(swim.css(60, 0, p), p);
  assert.match(s, /^- Hold CSS 100mtr 98-101% Pace\n- Rest 15s$/m);
  for (const line of [t, r, s].join('\n').split('\n').filter((l) => l.startsWith('- '))) {
    assert.match(line, /^- ([A-Za-z' -]+ )?\d+(m|s|mtr|m\d+s)( (ramp )?\d+(-\d+)?%( Pace| LTHR)?)?( \d+rpm)?$/, line);
  }
});

test('readiness: suppressed HRV and elevated RHR trigger adjust/recover; symptoms force recovery', () => {
  const mk = (n: number, hrv: (i: number) => number, rhr: (i: number) => number): Wellness[] =>
    Array.from({ length: n }, (_, i) => ({ date: addDays(TODAY, i - n + 1), hrv: hrv(i), restingHR: rhr(i), ctl: 60, atl: 62 }));
  const steady = mk(40, (i) => 70 + (i % 5), () => 45);
  assert.equal(assessReadiness(TODAY, steady).status, 'go');
  const tired = mk(40, (i) => (i >= 33 ? 48 : 70 + (i % 5)), (i) => (i === 39 ? 53 : 45));
  const r = assessReadiness(TODAY, tired);
  assert.ok(r.status === 'adjust' || r.status === 'recover', r.status);
  assert.equal(assessReadiness(TODAY, steady, { date: TODAY, symptoms: true }).status, 'recover');
  assert.equal(assessReadiness(TODAY, []).status, 'unknown');
});

test('plan: generation keeps locked sessions, reconciles activities and adapts to readiness', () => {
  const s = emptyState();
  s.profile = profile();
  s.races = races;
  generate(s, TODAY);
  assert.ok(s.sessions.every((x) => x.date >= TODAY), 'never plans the past');
  assert.ok(s.sessions.some((x) => x.date >= '2026-11-30'), 'four weeks of detail');
  const custom = customWorkout({ sport: 'bike', name: 'My 3x12', blocks: [{ name: 'Main', repeat: 3, steps: [{ kind: 'work', secs: 720, lo: 0.95, hi: 1 }, { kind: 'recovery', secs: 240, lo: 0.5, hi: 0.5 }] }] }, s.profile);
  assert.equal(custom.durationMin, 48);
  assert.equal(custom.hard, true);
  s.sessions.push({ id: 'mine', date: '2026-11-19', sport: 'bike', role: 'key', workout: custom, status: 'planned', locked: true, origin: 'custom' });
  generate(s, TODAY, 'week');
  assert.ok(s.sessions.some((x) => x.id === 'mine'));
  assert.equal(s.sessions.filter((x) => x.date === '2026-11-19' && x.sport === 'bike').length, 1, 'custom session replaces the planned bike that day');

  const first = s.sessions.find((x) => x.sport === 'bike')!;
  s.activities = [{ id: 'i1', date: first.date, sport: 'bike', name: 'Morning ride', durationMin: first.workout.durationMin + 3, tss: 50 }];
  assert.equal(reconcile(s), 1);
  assert.equal(first.status, 'done');
  assert.equal(reconcile(s), 0, 'idempotent');

  // Force a hard session today and check both adaptations.
  const hard = { id: 'h', date: TODAY, sport: 'bike' as const, role: 'key' as const, workout: bike.vo2(70, 1, s.profile), status: 'planned' as const, locked: false, origin: 'plan' as const };
  s.sessions = s.sessions.filter((x) => x.date !== TODAY).concat(hard);
  const changes = applyReadiness(s, TODAY, { status: 'recover', score: 30, headline: '', advice: '', signals: [] });
  assert.equal(changes.length, 1);
  assert.equal(hard.workout.code, 'bike.recovery');
  assert.equal(hard.locked, true);
  assert.equal(finalize(hard.workout, s.profile).tss, hard.workout.tss);
});

test('reconcile: matches a session done on another day, records what was done, and leaves true extras unplanned', async () => {
  const { unplannedActivities } = await import('../src/engine/plan.ts');
  const s = emptyState();
  s.profile = profile();
  generate(s, '2026-11-09');
  const longRun = s.sessions.find((x) => x.role === 'long' && x.sport === 'run' && x.date <= '2026-11-15')!;
  assert.equal(longRun.date, '2026-11-15');
  const before = s.sessions.filter((x) => x.sport === 'run' && x.date <= '2026-11-15').length;
  s.activities = [
    // long run done a day early and much longer than prescribed
    { id: 'r1', date: '2026-11-14', sport: 'run', name: 'Hilly 24k', durationMin: 118, tss: 131, distanceKm: 24.1, avgHr: 149, intensity: 0.82 },
    // a walk-length yoga-ish thing with no counterpart, and a short run far from any open session
    { id: 'o1', date: '2026-11-12', sport: 'other', name: 'Hike', durationMin: 90, tss: 30 },
    { id: 'r2', date: '2026-11-09', sport: 'run', name: 'Shake-out', durationMin: 12, tss: 8 },
  ];
  assert.equal(reconcile(s), 1);
  const done = s.sessions.find((x) => x.actual?.activityId === 'r1')!;
  assert.equal(done.id, longRun.id, 'paired with the long run, not a short run');
  assert.equal(done.status, 'done');
  assert.equal(done.date, '2026-11-14');
  assert.equal(done.actual!.plannedDate, '2026-11-15');
  assert.equal(done.actual!.durationMin, 118);
  assert.equal(done.actual!.distanceKm, 24.1);
  assert.equal(s.sessions.filter((x) => x.sport === 'run' && x.date <= '2026-11-15').length, before, 'no session duplicated or lost');
  assert.deepEqual(unplannedActivities(s, '2026-11-09').map((a) => a.id).sort(), ['o1', 'r2']);
  // an edited activity refreshes the recorded numbers on the next sync without re-matching
  s.activities[0].tss = 140;
  assert.equal(reconcile(s), 0);
  assert.equal(done.actual!.tss, 140);
});

test('duathlon and aquathlon targets: accepted as races and shift the discipline mix near the race', () => {
  const p = { ...profile(), comeback: { active: false, weeksOff: 0 } }, a = defaultAvailability();
  const mins = (type: Race['type'], phase: string) => {
    const { weeks } = buildSeason({ today: TODAY, profile: p, availability: a, races: [{ id: 'x', name: 'Target', date: '2027-06-27', type, priority: 'A' }], ctl: 60 });
    const wk = weeks.find((w) => w.phase === phase && !w.recovery)!;
    assert.equal(wk.targetRace, type);
    const out = { swim: 0, bike: 0, run: 0, strength: 0, race: 0 };
    const { sessions } = buildWeek(wk, p, a);
    for (const s of sessions) out[s.sport] += s.workout.durationMin;
    return { ...out, raceTss: sessions.find((s) => s.sport === 'race')?.workout.tss };
  };
  const tri = mins('sprint', 'specific'), du = mins('duathlonSprint', 'specific'), aq = mins('aquathlon', 'specific');
  assert.ok(du.swim < tri.swim * 0.7 && du.swim > 0, `duathlon keeps a maintenance swim: ${du.swim} vs ${tri.swim}`);
  assert.ok(du.run > tri.run, 'duathlon adds run time');
  assert.ok(aq.bike < tri.bike * 0.8 && aq.swim >= tri.swim && aq.run > tri.run, `aquathlon: ${JSON.stringify(aq)} vs ${JSON.stringify(tri)}`);
  // base phase stays full triathlon training
  assert.deepEqual(mins('duathlon', 'base'), mins('olympic', 'base'));
  const raceWeek = mins('duathlon', 'race');
  assert.equal(raceWeek.swim, 0);
  assert.equal(raceWeek.raceTss, 170);
  assert.equal(mins('aquathlon', 'race').raceTss, 55);
});

test('availability: with no limits the plan lays out its optimal week; fixed days and limits are then honoured', () => {
  const p = { ...profile(), comeback: { active: false, weeksOff: 0 }, currentWeeklyHours: 11 };
  const open = defaultAvailability();
  assert.ok(open.days.every((d) => d.minutes === null));
  const wk = (a: ReturnType<typeof defaultAvailability>) => {
    const { weeks } = buildSeason({ today: TODAY, profile: p, availability: a, races, ctl: 70 });
    const w = weeks.find((x) => x.phase === 'build' && !x.recovery)!;
    return { w, ...buildWeek(w, p, a) };
  };
  const best = wk(open);
  const on = (r: { sessions: any[] }, f: (s: any) => boolean) => r.sessions.filter(f).map((s) => dow(s.date));
  assert.deepEqual(best.warnings, [], 'nothing has to be dropped from an unconstrained week');
  assert.deepEqual(on(best, (s) => s.role === 'long' && s.sport === 'bike'), [5], 'long ride on Saturday');
  assert.deepEqual(on(best, (s) => s.role === 'long' && s.sport === 'run'), [6], 'long run on Sunday');
  assert.ok(!best.sessions.some((s) => dow(s.date) === 0), 'Monday kept free');
  const tss = best.sessions.reduce((t, s) => t + s.workout.tss, 0);
  assert.ok(Math.abs(tss - best.w.targetTss) / best.w.targetTss < 0.08, `optimal week hits its load target: ${tss} vs ${best.w.targetTss}`);
  const byDay = (r: { sessions: any[] }) => { const m = [0, 0, 0, 0, 0, 0, 0]; for (const s of r.sessions) m[dow(s.date)] += s.workout.durationMin; return m; };

  // Fixed days: swims on Mon/Wed/Fri exactly, strength Tue/Thu, long run Saturday, long ride Sunday, rest Thursday.
  const fixed = wk({ ...open, fixed: { swim: [0, 2, 4], strength: [1, 3], longRun: 5, longRide: 6, rest: 3 } });
  assert.deepEqual(on(fixed, (s) => s.sport === 'swim').sort(), [0, 2, 4]);
  assert.ok(on(fixed, (s) => s.sport === 'strength').every((d) => d === 1), 'strength only on a fixed day that is not the rest day');
  assert.deepEqual(on(fixed, (s) => s.role === 'long' && s.sport === 'run'), [5]);
  assert.deepEqual(on(fixed, (s) => s.role === 'long' && s.sport === 'bike'), [6]);
  assert.ok(!fixed.sessions.some((s) => dow(s.date) === 3), 'fixed rest day is empty');

  // Negotiating down: cap Tuesday at 45 min and the day shrinks while the rest of the week absorbs what it can.
  const capped = wk({ ...open, days: open.days.map((d, i) => (i === 1 ? { ...d, minutes: 45 } : d)) });
  assert.ok(byDay(best)[1] > 45, 'the optimal Tuesday was longer than the new limit');
  assert.ok(byDay(capped)[1] <= 45);
  assert.ok(capped.sessions.length >= best.sessions.length - 2);
});

test('unlink: an activity matched to the wrong session can be detached, stays detached, and the session is free to move', async () => {
  const { unlinkSession, linkActivity, unplannedActivities } = await import('../src/engine/plan.ts');
  const { analyzeExecution, applyProgress } = await import('../src/engine/execution.ts');
  const s = emptyState();
  s.profile = profile();
  generate(s, '2027-01-04');
  const sweet = s.sessions.find((x) => x.workout.code === 'bike.sweetspot')!;
  const easyBike = s.sessions.find((x) => x.workout.code === 'bike.endurance' && x.date !== sweet.date && x.status === 'planned')!;
  // Tuesday: an easy ride was done where the sweet spot was planned.
  s.activities = [{ id: 'easy', date: sweet.date, sport: 'bike', name: 'Easy spin', durationMin: 55, tss: 38, distanceKm: 24, intensity: 0.64 }];
  assert.equal(reconcile(s), 1);
  assert.equal(sweet.actual?.activityId, 'easy');
  assert.equal(sweet.status, 'done');
  // grading it against the sweet spot earned a (negative) progression step
  sweet.actual!.exec = { ...analyzeExecution(sweet, [{ type: 'WORK', moving_time: 600, average_watts: 150 }, { type: 'WORK', moving_time: 600, average_watts: 150 }], s.profile)!, verdict: 'under' };
  s.progress = {};
  applyProgress(s.progress, sweet.workout.code, sweet.actual!.exec);
  assert.deepEqual(s.progress, { 'bike.sweetspot': -1 });

  const r = unlinkSession(s, sweet.id);
  assert.equal(r.name, sweet.workout.name);
  assert.equal(sweet.actual, undefined);
  assert.equal(sweet.status, 'planned');
  assert.equal(sweet.locked, false, 'a plan session is the plan’s again');
  assert.deepEqual(s.progress, {}, 'progression from the wrong grading is taken back');
  assert.deepEqual(unplannedActivities(s, '2027-01-01').map((a) => a.id), ['easy']);
  assert.throws(() => unlinkSession(s, sweet.id), /not linked/);
  // the session can now be moved, and a later sync must not re-link the activity
  const tuesday = sweet.date;
  sweet.date = addDays(tuesday, 2);
  assert.equal(reconcile(s), 0);
  assert.equal(sweet.actual, undefined);
  assert.equal(sweet.date, addDays(tuesday, 2), 'still where the athlete put it');
  assert.deepEqual(s.unlinked, ['easy']);

  // link it to the session it really was; the session takes the activity's day
  const before = easyBike.date;
  linkActivity(s, 'easy', easyBike.id);
  assert.equal(easyBike.status, 'done');
  assert.equal(easyBike.date, tuesday, 'the session takes the day the activity was done');
  assert.equal(easyBike.actual!.activityId, 'easy');
  assert.equal(easyBike.actual!.plannedDate, before);
  assert.deepEqual(s.unlinked, []);
  // same-sport rule and moving a link between sessions
  const run = s.sessions.find((x) => x.sport === 'run' && x.status === 'planned')!;
  assert.throws(() => linkActivity(s, 'easy', run.id), /same sport/);
  linkActivity(s, 'easy', sweet.id);
  assert.equal((sweet as import('../src/engine/types.ts').Session).actual!.activityId, 'easy');
  assert.equal(easyBike.actual, undefined, 'the link moved rather than duplicating');
  assert.equal(easyBike.status, 'planned');
  // a session that moved because of matching goes back to where it was planned
  const long = s.sessions.find((x) => x.role === 'long' && x.sport === 'run')!;
  const planned = long.date;
  s.activities.push({ id: 'lr', date: addDays(planned, -1), sport: 'run', name: 'Long run', durationMin: long.workout.durationMin, tss: long.workout.tss });
  reconcile(s);
  assert.equal(long.date, addDays(planned, -1));
  const u = unlinkSession(s, long.id);
  assert.equal(u.restoredDate, planned);
  assert.equal(long.date, planned);
});
