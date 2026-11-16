import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bikeSpeed, buildLeg, courseDemands, gapAnalysis, predictRace } from '../src/engine/course.ts';
import { analyzeExecution, applyProgress, plannedReps } from '../src/engine/execution.ts';
import { breakWindow, comebackTracker, learnedRamp } from '../src/engine/insights.ts';
import { applyAdaptations, proposeAdaptations } from '../src/engine/adapt.ts';
import { emptyState, generate, viewState } from '../src/engine/plan.ts';
import { bike } from '../src/engine/workouts.ts';
import { addDays } from '../src/engine/dates.ts';
import type { Activity, Profile, Race, Session, Wellness } from '../src/engine/types.ts';

const P = (): Profile => ({ ...emptyState().profile, ftp: 280, runPower: 340, runPaceSecPerKm: 235, cssSecPer100: 92, weightKg: 72, birthYear: 1990, comeback: { active: false, weeksOff: 0 } });

/** A synthetic out-and-back: flat, then `n` climbs of `km` at `grade`, each followed by its descent. */
function track(flatKm: number, n: number, km: number, grade: number): [number, number, number][] {
  const pts: [number, number, number][] = [];
  let d = 0, e = 100;
  const push = () => pts.push([45, 7 + d / 78850, e]); // ~78.85 km per degree of longitude at 45°N
  const go = (len: number, g: number) => { for (let i = 0; i < len * 20; i++) { d += 50; e += 50 * g; push(); } };
  push();
  go(flatKm, 0);
  for (let i = 0; i < n; i++) { go(km, grade); go(km, -grade); go(2, 0); }
  return pts;
}

test('course: GPX points become a leg with distance, climbing and climbs', () => {
  const leg = buildLeg(track(10, 3, 4, 0.05));
  assert.ok(Math.abs(leg.km - 40) < 0.5, `km ${leg.km}`);
  assert.ok(Math.abs(leg.gain - 600) < 40, `gain ${leg.gain}`);
  assert.equal(leg.climbs.length, 3);
  assert.ok(Math.abs(leg.climbs[0].km - 4) < 0.5 && Math.abs(leg.climbs[0].grade - 5) < 0.6, JSON.stringify(leg.climbs[0]));
  assert.ok(leg.profile.length <= 301);
  assert.throws(() => buildLeg([[45, 7, 100]]), /too few/);
  assert.equal(buildLeg(track(30, 0, 0, 0)).climbs.length, 0);
  // a long false flat running into a climb must not hide the climb
  const pts = track(5, 0, 0, 0);
  let d = 5000, e = 100;
  const go = (km: number, g: number) => { for (let i = 0; i < km * 20; i++) { d += 50; e += 50 * g; pts.push([45, 7 + d / 78850, e]); } };
  go(6, 0.002); go(3, 0.04); go(3, -0.04);
  const ff = buildLeg(pts);
  assert.equal(ff.climbs.length, 1);
  assert.ok(Math.abs(ff.climbs[0].km - 3) < 0.6 && ff.climbs[0].grade > 3.3, JSON.stringify(ff.climbs[0]));
});

test('course: physics, split prediction and course-shaped pacing', () => {
  const v = bikeSpeed(230, 0, 81, 0.27, 1.225) * 3.6;
  assert.ok(v > 36 && v < 40, `flat speed at 230 W: ${v}`);
  assert.ok(bikeSpeed(230, 0.06, 81, 0.27, 1.225) * 3.6 < 16);
  const p = P();
  const flat: Race = { id: 'f', name: 'Flat 70.3', date: '2027-06-27', type: 'half', priority: 'A' };
  const a = predictRace(flat, p)!;
  const [sw, bk, rn] = a.legs.map((l) => l.secs!);
  assert.ok(sw > 29 * 60 && sw < 33 * 60, `swim ${sw}`);
  assert.ok(bk > 2.2 * 3600 && bk < 2.5 * 3600, `bike ${bk}`);
  assert.ok(rn > 88 * 60 && rn < 94 * 60, `run ${rn}`);
  assert.equal(a.total, sw + bk + rn + a.transitions);
  const hilly: Race = { ...flat, id: 'h', course: { bike: buildLeg(track(10, 3, 4, 0.05)), tempC: 30 } };
  const sameFlat: Race = { ...flat, id: 'sf', course: { bike: buildLeg(track(40, 0, 0, 0)), tempC: 30 } };
  const b = predictRace(hilly, p)!;
  assert.ok(Math.abs(b.legs[1].km - 40) < 0.3);
  assert.ok(b.legs[1].secs! > predictRace(sameFlat, p)!.legs[1].secs! + 120, 'climbing costs time at the same distance and normalised power');
  assert.ok(Math.abs(b.bike!.np - 0.82 * 280) <= 2, `NP held at target: ${b.bike!.np}`);
  assert.ok(b.bike!.climbs[0].watts > b.bike!.np, 'climbs ridden above average power');
  assert.ok(b.bike!.climbs[0].watts <= 0.82 * 280 * 1.2);
  const d = courseDemands(hilly, p)!;
  assert.equal(d.hot, true);
  assert.equal(d.climbMin.length, 3);
  assert.equal(predictRace(flat, { ...p, ftp: undefined })!.total, null);
  assert.equal(predictRace({ ...flat, type: 'duathlon' }, p)!.legs.length, 3);
});

test('gap analysis: finds the discipline furthest from the target splits', () => {
  const p = P();
  const race: Race = { id: 'g', name: 'Target', date: '2027-06-27', type: 'half', priority: 'A' };
  const pr = predictRace(race, p)!;
  race.podium = { swim: pr.legs[0].secs! - 30, bike: pr.legs[1].secs! - 120, run: Math.round(pr.legs[2].secs! * 0.93) };
  const g = gapAnalysis(race, p)!;
  assert.equal(g.focus, 'run');
  assert.equal(g.rows.length, 3);
  assert.ok(g.rows.find((r) => r.sport === 'bike')!.perPercent > 20);
  assert.match(g.text, /largest relative deficit is the run/);
  race.podium = { swim: pr.legs[0].secs! + 60, bike: pr.legs[1].secs! + 60, run: pr.legs[2].secs! + 60 };
  assert.equal(gapAnalysis(race, p)!.focus, null);
});

test('a course on the A-race shapes the specific block and adds heat acclimation near the race', () => {
  const s = emptyState();
  s.profile = P();
  const leg = buildLeg(track(10, 3, 4, 0.05));
  s.races = [{ id: 'a', name: 'Hilly hot 70.3', date: '2027-01-24', type: 'half', priority: 'A', course: { bike: leg, tempC: 31 } }];
  generate(s, '2026-12-28'); // 3-4 weeks out: specific + taper + race are inside the detailed horizon
  const wk = s.season!.weeks;
  assert.equal(wk.find((w) => w.phase === 'race')!.weeksOut, 0);
  assert.equal(wk[0].course!.terrain, 'hilly');
  const climbs = s.sessions.filter((x) => x.workout.code === 'bike.course');
  assert.ok(climbs.length >= 1, 'course session scheduled');
  assert.match(climbs[0].workout.name, /Course climbs \d×\d+ min/);
  assert.ok(s.sessions.some((x) => /Heat acclimation/.test(x.workout.notes ?? '')), 'heat note present');
  assert.ok(!s.sessions.filter((x) => x.workout.hard).some((x) => /Heat acclimation/.test(x.workout.notes ?? '')), 'never on hard sessions');
  const v = viewState(s, '2026-12-28');
  // the GPX is 40 km, so the course distance (not the standard 90 km) drives the bike split
  assert.ok(v.races[0].analysis.prediction!.total! > 2.5 * 3600);
  assert.ok(Math.abs(v.races[0].analysis.prediction!.legs[1].km - 40) < 0.3);
});

test('execution: grades reps against the prescription and moves progression', () => {
  const p = P();
  const w = bike.threshold(75, 0, p); // 4×8 min at 96–102%
  const x: Session = { id: 's', date: '2027-01-05', sport: 'bike', role: 'key', workout: w, status: 'done', locked: true, origin: 'plan' };
  assert.equal(plannedReps(x, p).length, 4);
  const iv = (watts: number, t = 480) => ({ type: 'WORK', moving_time: t, average_watts: watts });
  const rec = { type: 'RECOVERY', moving_time: 180, average_watts: 140 };
  const good = analyzeExecution(x, [iv(275), rec, iv(277), rec, iv(276), rec, iv(278)], p)!;
  assert.equal(good.verdict, 'nailed');
  assert.equal(good.doneReps, 4);
  const over = analyzeExecution(x, [iv(300), iv(301), iv(299), iv(302)], p)!;
  assert.equal(over.verdict, 'over');
  const short = analyzeExecution(x, [iv(276), iv(274)], p)!;
  assert.equal(short.verdict, 'cut short');
  const faded = analyzeExecution(x, [iv(290), iv(280), iv(268), iv(262)], p)!;
  assert.ok(faded.fade! < -8);
  assert.match(faded.text, /faded/);
  assert.equal(analyzeExecution(x, [{ type: 'WORK', moving_time: 3600, average_watts: 190 }], p)!.verdict, 'unstructured');
  assert.equal(analyzeExecution({ ...x, workout: bike.endurance(60, 0, p) }, [], p), null);
  const progress: Record<string, number> = {};
  assert.equal(applyProgress(progress, 'bike.threshold', over), 1);
  assert.equal(applyProgress(progress, 'bike.threshold', good), 0);
  assert.equal(applyProgress(progress, 'bike.vo2.3015', short), -1);
  assert.deepEqual(progress, { 'bike.threshold': 1, 'bike.vo2': -1 });

  // The earned level shows up in the next plan.
  const s = emptyState();
  s.profile = { ...P(), currentWeeklyHours: 14, maxWeeklyHours: 18 };
  for (const d of s.availability.days) d.minutes = 180; // enough time that session length is not what limits the level
  const name = (prog: Record<string, number>) => { s.progress = prog; s.sessions = []; generate(s, '2027-01-04'); return s.sessions.find((q) => q.workout.code === 'bike.sweetspot')!.workout.name; };
  assert.notEqual(name({}), name({ 'bike.sweetspot': 2 }));
});

test('insights: comeback tracker and learned ramp', () => {
  const p = { ...P(), comeback: { active: true, weeksOff: 8, resumedOn: '2026-10-19' } };
  const acts: Activity[] = [], well: Wellness[] = [];
  const add = (date: string, sport: Activity['sport'], min: number, x: Partial<Activity> = {}) => acts.push({ id: `a${acts.length}`, date, sport, name: 'x', durationMin: min, tss: min, ...x });
  for (let d = '2025-09-01'; d < '2026-08-24'; d = addDays(d, 7)) { add(d, 'bike', 180, { np: 225, distanceKm: 95 }); add(addDays(d, 1), 'run', 95, { distanceKm: 20 }); add(addDays(d, 2), 'bike', 45, { np: 262 }); }
  for (let d = '2026-10-19'; d < '2026-11-11'; d = addDays(d, 7)) { add(d, 'bike', 120, { np: 198, distanceKm: 58 }); add(addDays(d, 1), 'run', 60, { distanceKm: 11.5 }); add(addDays(d, 2), 'bike', 40, { np: 236 }); }
  for (let d = '2025-09-01', c = 40; d <= '2026-11-11'; d = addDays(d, 1)) { c = d < '2026-08-24' ? Math.min(85, c + 0.2) : d < '2026-10-19' ? c - 0.8 : c + 0.3; well.push({ date: d, ctl: c, atl: c }); }
  assert.deepEqual(breakWindow(p, acts, '2026-11-11'), { start: '2026-08-24', end: '2026-10-19', source: 'profile' });
  const detected = breakWindow({ ...p, comeback: { active: true, weeksOff: 8 } }, acts, '2026-11-11')!;
  assert.equal(detected.source, 'detected');
  assert.ok(detected.start >= '2026-08-17' && detected.start <= '2026-08-31', detected.start);
  const cb = comebackTracker(p, acts, well, [{ start: '2027-03-01', ctlEnd: 70 } as any, { start: '2027-04-05', ctlEnd: 82 } as any], '2026-11-11')!;
  const row = (l: string) => cb.rows.find((r) => r.label.startsWith(l))!;
  assert.equal(row('Fitness').before, '85');
  assert.equal(row('Best ride power, 20').pct, 90);
  assert.equal(row('Best ride power, 2.5').now, '—');
  assert.equal(row('Best run pace, 60').before, '4:45/km');
  assert.equal(row('Longest ride').pct, 67);
  assert.equal(cb.regain!.date, '2027-04-11');

  // Ramp history: three blocks at ~3/week that held, one at ~6/week followed by a collapse.
  const w2: Wellness[] = [];
  let c = 30, d = '2024-01-01';
  const run = (weeks: number, perWeek: number) => { for (let i = 0; i < weeks * 7; i++) { c += perWeek / 7; w2.push({ date: d, ctl: c }); d = addDays(d, 1); } };
  for (let k = 0; k < 3; k++) { run(5, 3); run(1, -2); run(1, 0); }
  run(4, 6); run(3, -5); run(6, 0.2); run(5, 3); run(8, 0);
  const lr = learnedRamp(w2)!;
  assert.equal(lr.broke.n, 1);
  assert.ok(lr.sustained.n >= 3);
  assert.ok(lr.suggested >= 2.5 && lr.suggested <= 3.6, `suggested ${lr.suggested}`);
  assert.equal(learnedRamp(w2.slice(0, 100)), null);
});

test('niggles: severity 2 removes intensity, severity 3 replaces runs with rides; resolved niggles do nothing', () => {
  const s = emptyState();
  s.profile = P();
  generate(s, '2027-01-04');
  const today = '2027-01-04';
  s.niggles = [{ id: 'n1', date: today, area: 'left Achilles', sport: 'run', severity: 2 }];
  let p = proposeAdaptations(s, today).filter((a) => a.kind === 'niggle');
  assert.equal(p.length, 1);
  assert.match(p[0].title, /left Achilles/);
  applyAdaptations(s, today);
  assert.ok(!s.sessions.some((x) => x.sport === 'run' && x.workout.hard && x.date <= addDays(today, 3)));
  assert.equal(proposeAdaptations(s, today).filter((a) => a.kind === 'niggle').length, 0);

  const t = emptyState();
  t.profile = P();
  generate(t, today);
  const runsBefore = t.sessions.filter((x) => x.sport === 'run' && x.date <= addDays(today, 6)).length;
  t.niggles = [{ id: 'n2', date: today, area: 'shin', sport: 'run', severity: 3 }];
  applyAdaptations(t, today);
  assert.ok(runsBefore > 0);
  assert.equal(t.sessions.filter((x) => x.sport === 'run' && x.status === 'planned' && x.date <= addDays(today, 6)).length, 0);
  assert.ok(t.sessions.some((x) => /Replaced .* with a ride/.test(x.adaptedNote ?? '')));
  t.niggles[0].resolved = today;
  assert.equal(proposeAdaptations(t, today).length, 0);
});
