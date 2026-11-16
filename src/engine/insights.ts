// Athlete-specific insights mined from imported history: where the athlete stands against their
// pre-break self, and the fitness ramp they have actually sustained in the past.
import type { Activity, Profile, SeasonWeek, Wellness } from './types.ts';
import { addDays, diffDays, mondayOf } from './dates.ts';

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : 0; };

/** The lay-off window: from the profile when the athlete entered it, otherwise detected from the data. */
export function breakWindow(p: Profile, activities: Activity[], today: string): { start: string; end: string; source: 'profile' | 'detected' } | null {
  if (p.comeback.resumedOn && p.comeback.weeksOff > 0) {
    return { start: addDays(p.comeback.resumedOn, -7 * p.comeback.weeksOff), end: p.comeback.resumedOn, source: 'profile' };
  }
  // Weekly hours for the last 18 months; a break is 2+ consecutive weeks under 35% of the prior 12-week median.
  const from = mondayOf(addDays(today, -7 * 78));
  const hours = new Map<string, number>();
  for (let w = from; w <= today; w = addDays(w, 7)) hours.set(w, 0);
  for (const a of activities) { const w = mondayOf(a.date); if (hours.has(w)) hours.set(w, hours.get(w)! + a.durationMin / 60); }
  const wk = [...hours].filter(([w]) => addDays(w, 6) < today);
  let best: { start: string; end: string } | null = null;
  for (let i = 12; i < wk.length; i++) {
    const base = median(wk.slice(i - 12, i).map(([, h]) => h));
    if (base < 3) continue;
    let j = i;
    while (j < wk.length && wk[j][1] < base * 0.35) j++;
    if (j - i >= 2) { best = { start: wk[i][0], end: j < wk.length ? wk[j][0] : today }; i = j; }
  }
  return best ? { ...best, source: 'detected' } : null;
}

export interface ComebackRow { label: string; before: string; now: string; pct: number | null }
export interface Comeback {
  window: { start: string; end: string; source: string };
  rows: ComebackRow[];
  /** When planned fitness regains 95% of the pre-break peak */
  regain: { date: string | null; peakPct: number } | null;
}
const pace = (kmh: number) => { const s = 3600 / kmh; return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}/km`; };
const pace100 = (kmh: number) => { const s = 360 / kmh; return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}/100m`; };
const hm = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;

export function comebackTracker(p: Profile, activities: Activity[], wellness: Wellness[], weeks: SeasonWeek[], today: string): Comeback | null {
  const win = breakWindow(p, activities, today);
  if (!win) return null;
  const preFrom = addDays(win.start, -365);
  const pre = activities.filter((a) => a.date >= preFrom && a.date < win.start);
  const post = activities.filter((a) => a.date >= win.end);
  if (!pre.length) return null;
  const rows: ComebackRow[] = [];
  const best = (list: Activity[], f: (a: Activity) => number | undefined) => list.reduce<number | null>((m, a) => { const v = f(a); return v != null && Number.isFinite(v) && (m == null || v > m) ? v : m; }, null);
  const add = (label: string, b: number | null, n: number | null, fmt: (v: number) => string) => {
    if (b == null) return;
    rows.push({ label, before: fmt(b), now: n == null ? '—' : fmt(n), pct: n == null ? null : Math.round((n / b) * 100) });
  };
  const ctlPre = best(wellness.filter((w) => w.date >= preFrom && w.date < win.start) as any, (w: any) => w.ctl);
  const ctlNow = wellness.filter((w) => w.ctl != null).at(-1)?.ctl ?? null;
  add('Fitness (CTL)', ctlPre, ctlNow, (v) => v.toFixed(0));
  const weekly = (list: Activity[], from: string, to: string) => list.filter((a) => a.date >= from && a.date < to).reduce((t, a) => t + a.durationMin, 0) / 60 / Math.max(1, diffDays(to, from) / 7);
  add('Weekly hours', weekly(pre, addDays(win.start, -84), win.start), post.length ? weekly(post, addDays(mondayOf(today), -28), mondayOf(today)) : null, (v) => `${v.toFixed(1)} h`);
  const speed = (a: Activity) => (a.distanceKm && a.durationMin ? a.distanceKm / (a.durationMin / 60) : undefined);
  for (const [lo, hi, label] of [[20, 60, '20–60 min'], [60, 150, '1–2.5 h'], [150, 1e4, '2.5 h+']] as [number, number, string][]) {
    const f = (a: Activity) => (a.sport === 'bike' && a.durationMin >= lo && a.durationMin < hi ? a.np : undefined);
    add(`Best ride power, ${label}`, best(pre, f), best(post, f), (v) => `${Math.round(v)} W NP`);
  }
  for (const [lo, label] of [[20, '20 min+'], [60, '60 min+'], [90, '90 min+']] as [number, string][]) {
    const f = (a: Activity) => (a.sport === 'run' && a.durationMin >= lo ? speed(a) : undefined);
    add(`Best run pace, ${label}`, best(pre, f), best(post, f), pace);
  }
  const sw = (a: Activity) => (a.sport === 'swim' && (a.distanceKm ?? 0) >= 1.5 ? speed(a) : undefined);
  add('Best swim pace, 1.5 km+', best(pre, sw), best(post, sw), pace100);
  for (const sport of ['bike', 'run'] as const) {
    const f = (a: Activity) => (a.sport === sport ? a.durationMin : undefined);
    add(`Longest ${sport === 'bike' ? 'ride' : 'run'}`, best(pre, f), best(post, f), hm);
  }
  let regain: Comeback['regain'] = null;
  if (ctlPre && weeks.length) {
    const hit = weeks.find((w) => w.ctlEnd >= ctlPre * 0.95);
    regain = { date: hit ? addDays(hit.start, 6) : null, peakPct: Math.round((Math.max(...weeks.map((w) => w.ctlEnd)) / ctlPre) * 100) };
  }
  return { window: win, rows, regain };
}

export interface LearnedRamp {
  /** Suggested CTL points per week for loading weeks */
  suggested: number;
  sustained: { n: number; median: number };
  broke: { n: number; median: number };
  text: string;
}
/**
 * What rate of fitness gain has this athlete actually held? Looks at every past block of 3+
 * consecutive rising weeks and whether it was followed by an unplanned collapse in load
 * (illness, injury, burnout all look the same in the data). A guide, not a physiological law.
 */
export function learnedRamp(wellness: Wellness[]): LearnedRamp | null {
  const ctl = wellness.filter((w) => w.ctl != null && w.ctl > 0);
  if (ctl.length < 180) return null;
  const weekly: number[] = [];
  for (let i = ctl.length - 1; i >= 0; i -= 7) weekly.unshift(ctl[i].ctl!);
  const d = weekly.slice(1).map((v, i) => v - weekly[i]);
  const ok: number[] = [], bad: number[] = [];
  for (let i = 0; i < d.length; i++) {
    if (d[i] < 1) continue;
    let j = i;
    while (j < d.length && d[j] >= 1) j++;
    if (j - i >= 3 && weekly[i] >= 15) {
      const ramp = (weekly[j] - weekly[i]) / (j - i);
      // Collapse: fitness falls by more than a normal recovery week explains within the next 3 weeks.
      const after = d.slice(j, j + 3);
      const collapsed = after.length === 3 && (after.reduce((t, x) => t + x, 0) <= -8 || after.some((x) => x <= -5));
      (collapsed ? bad : ok).push(ramp);
    }
    i = j;
  }
  if (ok.length + bad.length < 3 || !ok.length) return null;
  const sorted = [...ok].sort((a, b) => a - b);
  const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  let suggested = p75;
  if (bad.length) suggested = Math.min(suggested, Math.max(median(ok), Math.min(...bad) - 0.5));
  suggested = Math.round(Math.max(2, Math.min(7, suggested)) * 10) / 10;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    suggested, sustained: { n: ok.length, median: r1(median(ok)) }, broke: { n: bad.length, median: r1(median(bad)) },
    text: `${ok.length} past block${ok.length === 1 ? '' : 's'} of 3+ rising weeks held up, at a median ${r1(median(ok))} CTL/week`
      + (bad.length ? `; ${bad.length} ended in a sharp drop in training, at a median ${r1(median(bad))}/week.` : '; none ended in a sharp drop in training.'),
  };
}
