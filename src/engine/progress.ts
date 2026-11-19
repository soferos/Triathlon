// Progress overview: the evidence behind plan changes, in one place — fitness against what the plan
// assumed, where the athlete is in the rebuild block, the progression level of each workout type and
// the sessions that moved it, and how the thresholds every target depends on have changed.
import { addDays, diffDays, mondayOf } from './dates.ts';
import { rebuildWeeks } from './season.ts';
import { plannedReps, progressDelta, progressKey } from './execution.ts';
import type { State } from './plan.ts';

export const LEVEL_LABELS: Record<string, string> = {
  'bike.sweetspot': 'Bike · sweet spot', 'bike.threshold': 'Bike · threshold', 'bike.overunder': 'Bike · over-unders', 'bike.vo2': 'Bike · VO2max',
  'bike.racepace': 'Bike · race pace', 'bike.course': 'Bike · course climbs', 'run.hills': 'Run · hill reps', 'run.tempo': 'Run · tempo',
  'run.threshold': 'Run · threshold', 'run.vo2': 'Run · VO2max', 'swim.css': 'Swim · CSS sets',
};
const r1 = (n: number) => Math.round(n * 10) / 10;

function fitness(s: State, today: string) {
  const ctl = new Map(s.wellness.filter((w) => w.ctl != null).map((w) => [w.date, w.ctl!]));
  const at = (date: string) => { for (let i = 0; i < 7; i++) { const v = ctl.get(addDays(date, -i)); if (v != null) return r1(v); } return null; };
  const thisMonday = mondayOf(today), trace = s.planTrace ?? {};
  const traced = Object.keys(trace).sort();
  const floor = addDays(thisMonday, -7 * 26);
  // Always show the last twelve weeks of actual fitness; the plan's own line starts when it first recorded a projection.
  const wanted = addDays(thisMonday, -7 * 12);
  const first = traced.length && traced[0] < wanted ? traced[0] : wanted;
  const start = first < floor ? floor : first;
  const weeks: { start: string; end: string; planned: number | null; actual: number | null; future: boolean }[] = [];
  for (let w = start; w <= addDays(thisMonday, 7 * 14); w = addDays(w, 7)) {
    const end = addDays(w, 6), future = end >= today;
    // The past is compared with what the plan assumed back then; the future shows the current projection.
    const planned = future ? s.season?.weeks.find((x) => x.start === w)?.ctlEnd ?? null : trace[w]?.ctl ?? null;
    weeks.push({ start: w, end, planned: planned == null ? null : r1(planned), actual: future ? null : at(end), future });
  }
  const both = weeks.filter((w) => !w.future && w.planned != null && w.actual != null);
  const last = both.at(-1);
  const gap = last ? r1(last.actual! - last.planned!) : null;
  const text = !last ? (traced.length ? 'The plan’s own projections are recorded week by week from when it was first generated, so the comparison fills in as weeks complete. Until then the chart shows your actual fitness and the projection from here.' : 'The plan’s own projections are recorded from now on, so the planned line fills in week by week.')
    : Math.abs(gap!) < 2 ? `Right on the plan: fitness ${last.actual} against ${last.planned} projected at the end of the week of ${last.start}.`
      : gap! > 0 ? `${gap} CTL points ahead of the plan (${last.actual} against ${last.planned} at the end of the week of ${last.start}).`
        : `${Math.abs(gap!)} CTL points behind the plan (${last.actual} against ${last.planned} at the end of the week of ${last.start}). Next weeks’ targets are set from where you actually are, so nothing is made up.`;
  return { weeks, gap, text, now: ctl.size ? at(today) : null };
}

function rebuild(s: State, today: string) {
  const c = s.profile.comeback;
  if (!c.active) return null;
  const total = rebuildWeeks(c.weeksOff);
  if (!total) return { total: 0, served: 0, from: null, done: true, weeks: [], checks: [], note: 'Under two weeks off needs no separate rebuild block.' };
  const from = c.resumedOn ?? c.planStart ?? null;
  const served = from ? Math.max(0, Math.floor(diffDays(mondayOf(today), mondayOf(from)) / 7)) : 0;
  const weeks = Array.from({ length: total }, (_, i) => {
    const start = from ? addDays(mondayOf(from), 7 * i) : null;
    const past = start != null && addDays(start, 6) < today;
    const acts = start ? s.activities.filter((a) => a.date >= start && a.date <= addDays(start, 6)) : [];
    const target = start ? s.planTrace?.[start] : undefined;
    return { n: i + 1, start, state: past ? 'done' : start != null && start <= today ? 'current' : 'ahead', doneHours: r1(acts.reduce((t, a) => t + a.durationMin, 0) / 60), doneTss: Math.round(acts.reduce((t, a) => t + a.tss, 0)), targetTss: target?.tss ?? null };
  });
  const tested = !!from && s.sessions.some((x) => x.role === 'test' && x.status === 'done' && x.date >= mondayOf(from));
  const finished = weeks.filter((w) => w.state === 'done' && w.targetTss);
  const hit = finished.length ? finished.reduce((t, w) => t + Math.min(1, w.doneTss / w.targetTss!), 0) / finished.length : null;
  const niggles = (s.niggles ?? []).filter((n) => !n.resolved);
  const checks = [
    { label: `${total} weeks completed`, ok: served >= total, detail: `${Math.min(served, total)} of ${total} done` },
    { label: 'Load held at about plan', ok: hit != null && hit >= 0.8, detail: hit == null ? 'no completed week with a target yet' : `${Math.round(hit * 100)}% of planned load on average` },
    { label: 'No open niggles', ok: niggles.length === 0, detail: niggles.length ? niggles.map((n) => n.area).join(', ') : 'none logged' },
    { label: 'Thresholds re-tested', ok: tested, detail: tested ? 'a test session has been done' : 'the block ends with a test week' },
  ];
  return { total, served: Math.min(served, total), from, done: served >= total, weeks, checks, note: from ? null : 'No start date yet — it is set when the plan is generated.' };
}

function levels(s: State, today: string) {
  const recent = s.sessions.filter((x) => x.actual?.exec && x.date >= addDays(today, -60));
  const keys = new Set(Object.keys(s.progress ?? {}));
  for (const e of s.progressLog ?? []) keys.add(e.key);
  for (const x of recent) if (x.workout.code !== 'custom') keys.add(progressKey(x.workout.code));
  const rows = [...keys].map((key) => {
    const next = s.sessions.filter((x) => x.date >= today && x.status === 'planned' && progressKey(x.workout.code) === key).sort((a, b) => a.date.localeCompare(b.date))[0];
    return {
      key, label: LEVEL_LABELS[key] ?? key, offset: s.progress?.[key] ?? 0,
      planned: s.progressAtPlan?.[key] ?? 0,
      next: next ? { date: next.date, name: next.workout.name } : null,
      history: recent.filter((x) => progressKey(x.workout.code) === key).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5)
        .map((x) => ({ date: x.date, name: x.workout.name, activity: x.actual!.name, verdict: x.actual!.exec!.verdict, text: x.actual!.exec!.text, delta: progressDelta(x.actual!.exec!) })),
    };
  }).sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset) || a.label.localeCompare(b.label));
  const hardDone = s.sessions.filter((x) => x.actual && x.workout.hard && x.date >= addDays(today, -21) && plannedReps(x, s.profile).length);
  const pending = [...new Set([...Object.keys(s.progress ?? {}), ...Object.keys(s.progressAtPlan ?? {})])].filter((k) => (s.progress?.[k] ?? 0) !== (s.progressAtPlan?.[k] ?? 0)).map((k) => LEVEL_LABELS[k] ?? k);
  return { rows, graded: recent.length, ungraded: hardDone.filter((x) => !x.actual!.exec || x.actual!.exec.verdict === 'unstructured').length, hardDone: hardDone.length, pending };
}

type Series = { key: string; label: string; unit: 'W' | 'pace' | 'bpm'; current: number | null; before: number | null; changePct: number | null; points: { date: string; value: number }[] };
function thresholds(s: State, today: string): Series[] {
  const defs: [keyof State['profile'] & string, string, Series['unit']][] = [
    ['ftp', 'Bike FTP', 'W'], ['runPower', 'Run threshold power', 'W'], ['runPaceSecPerKm', 'Run threshold pace', 'pace'], ['cssSecPer100', 'Swim CSS', 'pace'], ['bikeLthr', 'Bike LTHR', 'bpm'], ['runLthr', 'Run LTHR', 'bpm'],
  ];
  const out: Series[] = [];
  for (const [key, label, unit] of defs) {
    const raw: { date: string; value: number }[] = [];
    for (const e of s.thresholdLog ?? []) { const v = (e as any)[key]; if (v) raw.push({ date: e.date, value: v }); }
    // Intervals.icu records the FTP in force on every activity, so bike FTP has a history from the start.
    if (key === 'ftp') for (const a of s.activities) if (a.ftp) raw.push({ date: a.date, value: a.ftp });
    raw.sort((a, b) => a.date.localeCompare(b.date));
    const points = raw.filter((p, i) => i === 0 || p.value !== raw[i - 1].value);
    const current = (s.profile as any)[key] ?? null;
    if (!current && !points.length) continue;
    // Only a value recorded at least three months ago counts as "before"; a newer history has nothing to compare with yet.
    const old = [...points].reverse().find((p) => p.date <= addDays(today, -90)) ?? null;
    out.push({ key, label, unit, current, before: old?.value ?? null, changePct: current && old && old.value ? Math.round(((current - old.value) / old.value) * 1000) / 10 : null, points });
  }
  return out;
}

export function progressOverview(s: State, today: string) {
  return { fitness: fitness(s, today), rebuild: rebuild(s, today), levels: levels(s, today), thresholds: thresholds(s, today) };
}
