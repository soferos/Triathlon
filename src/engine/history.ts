// Training-history analytics over everything imported from Intervals.icu.
import type { Activity, Wellness } from './types.ts';
import { addDays, mondayOf } from './dates.ts';

const SPORTS = ['swim', 'bike', 'run', 'strength', 'other'] as const;
type Bucket = Record<(typeof SPORTS)[number], number>;
const bucket = (): Bucket => ({ swim: 0, bike: 0, run: 0, strength: 0, other: 0 });
const r1 = (n: number) => Math.round(n * 10) / 10;

export function summarizeHistory(activities: Activity[], wellness: Wellness[], today: string) {
  if (!activities.length && !wellness.some((w) => w.ctl)) return null;
  const sportOf = (a: Activity) => (a.sport === 'race' ? 'other' : a.sport) as keyof Bucket;

  // Weekly minutes per sport + load, for every week from the first activity to now.
  const first = activities[0]?.date ?? today;
  const weekMap = new Map<string, { start: string; min: Bucket; tss: number }>();
  for (let w = mondayOf(first); w <= today; w = addDays(w, 7)) weekMap.set(w, { start: w, min: bucket(), tss: 0 });
  for (const a of activities) {
    const w = weekMap.get(mondayOf(a.date));
    if (!w) continue;
    w.min[sportOf(a)] += a.durationMin;
    w.tss += a.tss;
  }
  const allWeeks = [...weekMap.values()];
  const hoursOf = (w: { min: Bucket }) => SPORTS.reduce((t, k) => t + w.min[k], 0) / 60;
  // Completed weeks only for averages, so a half-finished current week does not drag them down.
  const done = allWeeks.filter((w) => addDays(w.start, 6) < today);
  const avg = (n: number) => (done.length ? r1(done.slice(-n).reduce((t, w) => t + hoursOf(w), 0) / Math.min(n, done.length)) : 0);
  let best6 = { hours: 0, end: '' };
  for (let i = 5; i < done.length; i++) {
    const h = done.slice(i - 5, i + 1).reduce((t, w) => t + hoursOf(w), 0) / 6;
    if (h > best6.hours) best6 = { hours: r1(h), end: addDays(done[i].start, 6) };
  }

  const years = new Map<string, { year: string; count: number; hours: Bucket; km: Bucket; tss: number }>();
  for (const a of activities) {
    const y = a.date.slice(0, 4);
    const row = years.get(y) ?? { year: y, count: 0, hours: bucket(), km: bucket(), tss: 0 };
    row.count++; row.hours[sportOf(a)] += a.durationMin / 60; row.km[sportOf(a)] += a.distanceKm ?? 0; row.tss += a.tss;
    years.set(y, row);
  }
  const round = (b: Bucket) => Object.fromEntries(SPORTS.map((k) => [k, Math.round(b[k])])) as Bucket;

  const yearAgo = addDays(today, -365);
  const longest: Record<string, { min: number; km?: number; date: string; name: string } | null> = { swim: null, bike: null, run: null };
  for (const a of activities) {
    if (a.date < yearAgo || !(a.sport in longest)) continue;
    const cur = longest[a.sport];
    if (!cur || a.durationMin > cur.min) longest[a.sport] = { min: a.durationMin, km: a.distanceKm, date: a.date, name: a.name };
  }

  const ctl = wellness.filter((w) => w.ctl != null && w.ctl > 0);
  const peak = ctl.reduce<Wellness | null>((m, w) => (!m || w.ctl! > m.ctl! ? w : m), null);
  // Weekly samples keep the all-time fitness chart light.
  const ctlSeries = ctl.filter((_, i) => i % 7 === 0 || i === ctl.length - 1).map((w) => ({ date: w.date, ctl: r1(w.ctl!) }));

  return {
    from: first, count: activities.length,
    weeks: allWeeks.slice(-52).map((w) => ({ start: w.start, min: w.min, tss: Math.round(w.tss) })),
    years: [...years.values()].sort((a, b) => b.year.localeCompare(a.year)).map((y) => ({ ...y, hours: round(y.hours), km: round(y.km), tss: Math.round(y.tss) })),
    avg4wkHours: avg(4), avg12wkHours: avg(12), best6wk: best6.hours ? best6 : null,
    peakCtl: peak ? { value: r1(peak.ctl!), date: peak.date } : null,
    longest, ctlSeries,
  };
}
