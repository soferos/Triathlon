import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAdaptations, proposeAdaptations } from '../src/engine/adapt.ts';
import { emptyState, generate, reconcile, type State } from '../src/engine/plan.ts';
import { addDays } from '../src/engine/dates.ts';
import type { Activity } from '../src/engine/types.ts';

// A normal base week (no comeback block) generated on Monday 2027-01-04.
const MON = '2027-01-04';
function fresh(): State {
  const s = emptyState();
  s.profile = { ...s.profile, ftp: 280, runPower: 340, cssSecPer100: 92, birthYear: 1990, currentWeeklyHours: 10, comeback: { active: false, weeksOff: 0 } };
  generate(s, MON);
  return s;
}
const act = (id: string, date: string, sport: Activity['sport'], durationMin: number, tss: number, x: Partial<Activity> = {}): Activity => ({ id, date, sport, name: id, durationMin, tss, ...x });
/** Complete every session before `today` exactly as planned. */
function doAsPlanned(s: State, today: string) {
  for (const x of s.sessions.filter((q) => q.date < today)) s.activities.push(act(`a-${x.id}`, x.date, x.sport, x.workout.durationMin, x.workout.tss));
  reconcile(s);
}

test('no proposals when the week goes to plan', () => {
  const s = fresh();
  doAsPlanned(s, '2027-01-07');
  assert.deepEqual(proposeAdaptations(s, '2027-01-07'), []);
  assert.deepEqual(proposeAdaptations(s, MON), []);
});

test('overload: trims easy volume first, keeps key sessions, and settles after applying', () => {
  const s = fresh();
  const today = '2027-01-07';
  doAsPlanned(s, today);
  const target = s.season!.weeks[0].targetTss;
  s.activities.push(act('epic', '2027-01-06', 'bike', 240, 230, { intensity: 0.76 })); // big unplanned ride
  const [p] = proposeAdaptations(s, today).filter((a) => a.kind === 'overload');
  assert.ok(p, 'overload proposed');
  assert.match(p.detail, new RegExp(`target of ${target}`));
  const hardBefore = s.sessions.filter((x) => x.date >= today && x.date <= '2027-01-10' && x.workout.hard).map((x) => x.workout.name);
  const changes = applyAdaptations(s, today);
  assert.ok(changes.some((c) => c.startsWith('Shortened')), changes.join(' '));
  const remaining = s.sessions.filter((x) => x.date >= today && x.date <= '2027-01-10' && x.status === 'planned');
  const projected = s.activities.reduce((t, a) => t + a.tss, 0) + remaining.reduce((t, x) => t + x.workout.tss, 0);
  assert.ok(projected <= target * 1.25, `projected ${projected} vs target ${target}`);
  // key sessions survive unless trimming alone could not get close
  const hardAfter = remaining.filter((x) => x.workout.hard).map((x) => x.workout.name);
  assert.ok(hardBefore.length - hardAfter.length <= 1);
  for (const x of remaining.filter((q) => q.origin === 'adapted')) { assert.equal(x.locked, true); assert.ok(x.adaptedNote); }
  assert.equal(proposeAdaptations(s, today).filter((a) => a.kind === 'overload').length, 0, 'does not keep trimming');
});

test('big day: a hard session the day after a blow-out is moved or made easy', () => {
  const s = fresh();
  const key = s.sessions.find((x) => x.workout.hard && x.sport !== 'strength' && x.date > MON)!;
  const today = key.date, yesterday = addDays(today, -1);
  doAsPlanned(s, yesterday);
  s.activities.push(act('race-effort', yesterday, 'run', 75, 125, { intensity: 0.97 }));
  reconcile(s);
  const p = proposeAdaptations(s, today).find((a) => a.kind === 'bigday');
  assert.ok(p, 'big-day proposed');
  assert.match(p.title, new RegExp(key.workout.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  applyAdaptations(s, today);
  assert.ok(key.date > today || !key.workout.hard, 'no hard session left on the day after');
  assert.equal(proposeAdaptations(s, today).filter((a) => a.kind === 'bigday').length, 0);
});

test('missed key session: rescheduled only where it fits, otherwise let go; dismissal sticks', () => {
  const s = fresh();
  const longRide = s.sessions.find((x) => x.role === 'long' && x.sport === 'bike')!;
  assert.equal(longRide.date, '2027-01-09'); // Saturday
  // Sunday: everything before was done except the long ride
  const today = '2027-01-10';
  for (const x of s.sessions.filter((q) => q.date < today && q !== longRide)) s.activities.push(act(`a-${x.id}`, x.date, x.sport, x.workout.durationMin, x.workout.tss));
  reconcile(s);
  const p = proposeAdaptations(s, today).find((a) => a.kind === 'missed')!;
  assert.ok(p, 'missed proposal');
  assert.match(p.title, /Long ride/);
  // Sunday already holds a bike session or the long run, so there is no room: advice only.
  assert.equal(p.actions.length, 0);
  assert.match(p.detail, /nothing needs making up/);
  applyAdaptations(s, today);
  assert.equal(longRide.date, '2027-01-09');
  assert.equal(proposeAdaptations(s, today).length, 0, 'acknowledged advice does not reappear');

  // Same miss, but with a free Sunday: the session moves.
  const t = fresh();
  const ride = t.sessions.find((x) => x.role === 'long' && x.sport === 'bike')!;
  t.sessions = t.sessions.filter((x) => x.date !== today);
  for (const x of t.sessions.filter((q) => q.date < today && q !== ride)) t.activities.push(act(`a-${x.id}`, x.date, x.sport, x.workout.durationMin, x.workout.tss));
  reconcile(t);
  const q = proposeAdaptations(t, today).find((a) => a.kind === 'missed')!;
  assert.equal(q.actions.length, 1);
  const kept = [...(t.dismissedAdapt ?? []), q.key];
  applyAdaptations(t, today);
  assert.equal(ride.date, today);
  assert.equal(ride.origin, 'adapted');
  // dismissing instead of applying hides it
  const u = fresh();
  u.dismissedAdapt = kept;
  assert.ok(!proposeAdaptations(u, today).some((a) => a.key === q.key));
});
