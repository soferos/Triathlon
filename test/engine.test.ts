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

test('week: respects availability, pool access, rest day and hard-day rules across the season', () => {
  const p = profile(), a = defaultAvailability();
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
