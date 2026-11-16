// Course modelling: turns GPX tracks into legs with climbs, predicts race splits from current
// thresholds with a physics model for the bike, compares them with the athlete's target splits,
// and summarises what the course demands so specific-phase training can mirror it.
import type { Climb, CourseDemands, CourseLeg, Profile, Race, RaceModel, RaceType, Sport } from './types.ts';

type Pt = [number, number, number]; // lat, lon, elevation

const R = 6371000;
const hav = (a: Pt, b: Pt) => {
  const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** Build a leg from raw track points: resample to 100 m, smooth elevation, find climbs. */
export function buildLeg(points: Pt[]): CourseLeg {
  const pts = points.filter((p) => p.every(Number.isFinite));
  if (pts.length < 2) throw new Error('The track has too few points with elevation.');
  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + hav(pts[i - 1], pts[i]));
  const total = dist.at(-1)!;
  if (total < 500) throw new Error('The track is shorter than 500 m.');
  // Resample every 100 m by linear interpolation.
  const step = 100, n = Math.floor(total / step);
  const ele: number[] = [];
  for (let k = 0, j = 0; k <= n; k++) {
    const d = k * step;
    while (j < dist.length - 2 && dist[j + 1] < d) j++;
    const span = dist[j + 1] - dist[j] || 1;
    ele.push(pts[j][2] + ((d - dist[j]) / span) * (pts[j + 1][2] - pts[j][2]));
  }
  // GPS/barometric noise inflates climbing; a 500 m moving average removes most of it.
  const sm = ele.map((_, i) => { const a = ele.slice(Math.max(0, i - 2), i + 3); return a.reduce((t, x) => t + x, 0) / a.length; });
  let gain = 0;
  for (let i = 1; i < sm.length; i++) if (sm[i] > sm[i - 1]) gain += sm[i] - sm[i - 1];

  // A climb runs from a low point to the high point after it; it ends once the road has dropped
  // 15 m from that high point or gone 1 km without setting a new one.
  const climbs: Climb[] = [];
  let i = 0;
  while (i < sm.length - 1) {
    if (sm[i + 1] <= sm[i]) { i++; continue; }
    let peak = i + 1, j = i + 1;
    while (j < sm.length - 1) {
      j++;
      if (sm[j] > sm[peak]) peak = j;
      else if (sm[peak] - sm[j] > 15 || j - peak > 10) break;
    }
    // A false flat leading into the climb is not part of it: start where the road first holds 2% over 500 m.
    let st = i;
    while (st < peak - 1) {
      const e = Math.min(peak, st + 5);
      if ((sm[e] - sm[st]) / ((e - st) * step) >= 0.02) break;
      st++;
    }
    const km = ((peak - st) * step) / 1000, g = sm[peak] - sm[st];
    if (g >= 40 && g / (km * 10) >= 2.5) climbs.push({ startKm: Math.round(st * step / 100) / 10, km: Math.round(km * 10) / 10, gain: Math.round(g), grade: Math.round((g / (km * 10)) * 10) / 10 });
    i = Math.max(peak, i + 1);
  }
  const stride = Math.max(1, Math.ceil(sm.length / 300));
  const profile: [number, number][] = [];
  for (let k = 0; k < sm.length; k += stride) profile.push([Math.round(k * step / 10) / 100, Math.round(sm[k])]);
  if (profile.at(-1)![0] < Math.round(total / 10) / 100) profile.push([Math.round(total / 10) / 100, Math.round(sm.at(-1)!)]);
  return { km: Math.round(total / 10) / 100, gain: Math.round(gain), profile, climbs };
}

// ---------- race model ----------
interface LegSpec { sport: Sport; label: string; km: number; frac: number }
/** Standard distances and the intensity (fraction of threshold) a well-trained athlete races each leg at. */
export function raceLegs(type: RaceType, model?: RaceModel): LegSpec[] {
  // The athlete's own fitted intensity for this race type and leg wins over the generic one.
  const L = (sport: Sport, label: string, km: number, frac: number): LegSpec => ({ sport, label, km, frac: model?.fracs[type]?.[label] ?? frac });
  switch (type) {
    case 'sprint': return [L('swim', 'Swim', 0.75, 1.01), L('bike', 'Bike', 20, 0.97), L('run', 'Run', 5, 1.0)];
    case 'olympic': return [L('swim', 'Swim', 1.5, 0.98), L('bike', 'Bike', 40, 0.92), L('run', 'Run', 10, 0.97)];
    case 'half': return [L('swim', 'Swim', 1.9, 0.95), L('bike', 'Bike', 90, 0.82), L('run', 'Run', 21.1, 0.91)];
    case 'full': return [L('swim', 'Swim', 3.8, 0.92), L('bike', 'Bike', 180, 0.71), L('run', 'Run', 42.2, 0.83)];
    case 'duathlonSprint': return [L('run', 'Run 1', 5, 1.0), L('bike', 'Bike', 20, 0.97), L('run', 'Run 2', 2.5, 0.98)];
    case 'duathlon': return [L('run', 'Run 1', 10, 0.98), L('bike', 'Bike', 40, 0.92), L('run', 'Run 2', 5, 0.96)];
    case 'aquathlon': return [L('swim', 'Swim', 1, 1.0), L('run', 'Run', 5, 1.01)];
    case 'run10k': return [L('run', 'Run', 10, 1.03)];
    case 'halfMarathon': return [L('run', 'Run', 21.1, 0.96)];
    case 'marathon': return [L('run', 'Run', 42.2, 0.88)];
    case 'bikeEvent': return [L('bike', 'Bike', 100, 0.8)];
    default: return [];
  }
}

const G = 9.81;
/** Steady-state speed (m/s) for a power on a gradient: solves the standard road-cycling power equation. */
export function bikeSpeed(watts: number, grade: number, mass: number, cda: number, rho: number, crr = 0.004): number {
  const theta = Math.atan(grade);
  const need = (v: number) => (mass * G * (Math.sin(theta) + crr * Math.cos(theta)) * v + 0.5 * rho * cda * v ** 3) / 0.975;
  let lo = 0.5, hi = 22; // 79 km/h ceiling: nobody pedals a triathlon descent faster
  if (need(hi) < watts) return hi;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (need(mid) < watts) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

export interface BikePlan {
  secs: number; kph: number; np: number; avgWatts: number; kj: number;
  climbs: (Climb & { watts: number; min: number })[];
  flatWatts: number;
}
/** Variable-power pacing: push the climbs, ease the descents, hold normalised power at the target. */
export function bikePlan(km: number, leg: CourseLeg | undefined, frac: number, p: Profile, race: Race, model?: RaceModel): BikePlan | null {
  if (!p.ftp) return null;
  const c = race.course ?? {};
  const mass = (p.weightKg ?? 75) + (c.bikeKg ?? 9);
  const cda = c.cda ?? model?.cda ?? 0.27, rho = 1.225 * (288 / (273 + (c.tempC ?? 15)));
  const target = frac * p.ftp;
  const segs: { m: number; grade: number; km: number }[] = [];
  if (leg && leg.profile.length > 1) {
    // Scale the track to the official distance so a slightly short/long GPX does not skew the split.
    const k = km / leg.km;
    for (let i = 1; i < leg.profile.length; i++) {
      const m = (leg.profile[i][0] - leg.profile[i - 1][0]) * 1000;
      if (m > 0) segs.push({ m: m * k, grade: (leg.profile[i][1] - leg.profile[i - 1][1]) / m, km: leg.profile[i - 1][0] });
    }
  } else segs.push({ m: km * 1000, grade: 0, km: 0 });
  const cap = frac > 0.9 ? 1.12 : frac > 0.78 ? 1.12 : 1.1;
  const mult = (g: number) => Math.max(0.35, Math.min(cap, 1 + 3 * g)); // +3% power per 1% gradient
  let s = 1, out = { t: [] as number[], w: [] as number[] };
  for (let it = 0; it < 8; it++) {
    out = { t: [], w: [] };
    let t4 = 0, tt = 0;
    for (const sg of segs) {
      const w = s * target * mult(sg.grade), t = sg.m / bikeSpeed(w, sg.grade, mass, cda, rho);
      out.t.push(t); out.w.push(w); t4 += t * w ** 4; tt += t;
    }
    s *= target / (t4 / tt) ** 0.25;
  }
  const secs = out.t.reduce((a, b) => a + b, 0), work = out.t.reduce((a, t, i) => a + t * out.w[i], 0);
  const np = (out.t.reduce((a, t, i) => a + t * out.w[i] ** 4, 0) / secs) ** 0.25;
  const climbs = (leg?.climbs ?? []).map((cl) => {
    let t = 0, w = 0;
    segs.forEach((sg, i) => { if (sg.km >= cl.startKm - 0.05 && sg.km < cl.startKm + cl.km) { t += out.t[i]; w += out.t[i] * out.w[i]; } });
    return { ...cl, watts: t ? Math.round(w / t) : Math.round(target * cap), min: Math.round(t / 6) / 10 };
  });
  const flat = segs.map((sg, i) => (Math.abs(sg.grade) < 0.01 ? out.w[i] : 0)).filter(Boolean);
  return {
    secs: Math.round(secs), kph: Math.round((km / (secs / 3600)) * 10) / 10, np: Math.round(np), avgWatts: Math.round(work / secs), kj: Math.round(work / 1000), climbs,
    flatWatts: Math.round(flat.length ? flat.reduce((a, b) => a + b, 0) / flat.length : target),
  };
}

export function runSecs(km: number, leg: CourseLeg | undefined, frac: number, p: Profile): number | null {
  if (!p.runPaceSecPerKm) return null;
  const base = p.runPaceSecPerKm / frac; // s/km on the flat
  if (!leg || leg.profile.length < 2) return km * base;
  const k = km / leg.km;
  let secs = 0;
  for (let i = 1; i < leg.profile.length; i++) {
    const d = leg.profile[i][0] - leg.profile[i - 1][0];
    if (d <= 0) continue;
    const g = ((leg.profile[i][1] - leg.profile[i - 1][1]) / (d * 1000)) * 100;
    // Uphill costs ~3.3% per 1% grade; downhill returns about half of that, and nothing beyond -8%.
    const f = g >= 0 ? 1 + 0.033 * g : Math.max(0.86, 1 + 0.018 * Math.max(g, -8));
    secs += d * k * base * f;
  }
  return secs;
}

export interface Prediction {
  legs: { sport: Sport; label: string; km: number; secs: number | null; note: string }[];
  transitions: number;
  total: number | null;
  bike: BikePlan | null;
  missing: string[];
}
export function predictRace(race: Race, p: Profile, model?: RaceModel): Prediction | null {
  const specs = raceLegs(race.type, model);
  if (!specs.length) return null;
  const c = race.course ?? {};
  const missing: string[] = [];
  let bike: BikePlan | null = null;
  const legs = specs.map((l) => {
    if (l.sport === 'swim') {
      if (!p.cssSecPer100) { missing.push('swim CSS'); return { ...l, secs: null, note: '' }; }
      const secs = (l.km * 10 * p.cssSecPer100) / l.frac / (c.wetsuit ? 1.03 : 1);
      return { ...l, secs: Math.round(secs), note: `${Math.round(l.frac * 100)}% of CSS${c.wetsuit ? ', wetsuit' : ''}` };
    }
    if (l.sport === 'bike') {
      const km = c.bike ? Math.round(c.bike.km * 10) / 10 : l.km;
      bike = bikePlan(km, c.bike, l.frac, p, race, model);
      if (!bike) { missing.push('bike FTP'); return { ...l, km, secs: null, note: '' }; }
      return { ...l, km, secs: bike.secs, note: `NP ${bike.np} W (${Math.round(l.frac * 100)}% FTP), ${bike.kph} km/h${c.bike ? `, ${c.bike.gain} m climbing` : ', flat assumed'}` };
    }
    const leg = l.label === 'Run 1' ? undefined : c.run;
    const km = leg ? Math.round(leg.km * 10) / 10 : l.km;
    const secs = runSecs(km, leg, l.frac, p);
    if (secs == null) { missing.push('run threshold pace'); return { ...l, km, secs: null, note: '' }; }
    return { ...l, km, secs: Math.round(secs), note: `${Math.round(l.frac * 100)}% of threshold pace${leg ? `, ${leg.gain} m climbing` : ''}` };
  });
  const transitions = specs.length > 1 ? Math.round((c.transitionMin ?? (specs.length - 1) * 2) * 60) : 0;
  const total = legs.every((l) => l.secs != null) ? legs.reduce((t, l) => t + l.secs!, 0) + transitions : null;
  return { legs, transitions, total, bike, missing: [...new Set(missing)] };
}

export interface GapRow { sport: 'swim' | 'bike' | 'run'; predicted: number; target: number; gap: number; pct: number; perPercent: number }
export interface Gap { rows: GapRow[]; totalGap: number | null; focus: 'swim' | 'bike' | 'run' | null; text: string }
/** Compare predicted splits with the athlete's target splits and find where the time is. */
export function gapAnalysis(race: Race, p: Profile, model?: RaceModel): Gap | null {
  const pred = predictRace(race, p, model);
  const pod = race.podium;
  if (!pred || !pod) return null;
  const sum = (sport: Sport, pr: Prediction) => pr.legs.filter((l) => l.sport === sport).reduce((t, l) => t + (l.secs ?? NaN), 0);
  // Seconds gained across the race from a 1% better threshold in one discipline.
  const better: Record<string, Profile> = {
    swim: { ...p, cssSecPer100: p.cssSecPer100 ? p.cssSecPer100 / 1.01 : undefined },
    bike: { ...p, ftp: p.ftp ? p.ftp * 1.01 : undefined },
    run: { ...p, runPaceSecPerKm: p.runPaceSecPerKm ? p.runPaceSecPerKm / 1.01 : undefined },
  };
  const rows: GapRow[] = [];
  for (const sport of ['swim', 'bike', 'run'] as const) {
    const predicted = sum(sport, pred), target = pod[sport];
    if (!target || !Number.isFinite(predicted) || !predicted) continue;
    const perPercent = predicted - sum(sport, predictRace(race, better[sport], model)!);
    rows.push({ sport, predicted: Math.round(predicted), target, gap: Math.round(predicted - target), pct: Math.round(((predicted - target) / target) * 1000) / 10, perPercent: Math.round(perPercent) });
  }
  const totalGap = pred.total != null && pod.total ? pred.total - pod.total : rows.length ? rows.reduce((t, r) => t + r.gap, 0) : null;
  const behind = rows.filter((r) => r.gap > 0).sort((a, b) => b.pct - a.pct);
  const focus = behind[0]?.sport ?? null;
  const mm = (s: number) => `${Math.floor(Math.abs(s) / 60)}:${String(Math.round(Math.abs(s) % 60)).padStart(2, '0')}`;
  let text: string;
  if (!rows.length) text = 'Enter target splits per discipline to see where the time is.';
  else if (!behind.length) text = 'On current thresholds you are already at or ahead of every target split. Execution on the day is the remaining question.';
  else {
    const f = behind[0];
    text = `The largest relative deficit is the ${f.sport}: ${mm(f.gap)} (${f.pct}%) behind target. Each 1% of ${f.sport} threshold is worth about ${mm(f.perPercent)} on this course, so closing it needs roughly ${Math.ceil(f.gap / Math.max(1, f.perPercent))}% more ${f.sport} fitness.`;
    if (behind.length > 1) text += ` Next: ${behind.slice(1).map((r) => `${r.sport} ${mm(r.gap)} (${r.pct}%)`).join(', ')}.`;
  }
  return { rows, totalGap: totalGap == null ? null : Math.round(totalGap), focus, text };
}

/** Reduce a course to the handful of facts that should shape training. */
export function courseDemands(race: Race, p: Profile, model?: RaceModel): CourseDemands | undefined {
  const c = race.course;
  if (!c) return undefined;
  const bikeSpec = raceLegs(race.type, model).find((l) => l.sport === 'bike');
  const plan = c.bike && bikeSpec ? bikePlan(c.bike.km, c.bike, bikeSpec.frac, p, race, model) : null;
  const perKm = c.bike ? c.bike.gain / c.bike.km : 0;
  const climbs = (plan?.climbs ?? []).filter((x) => x.min >= 3).sort((a, b) => b.min - a.min);
  const hot = (c.tempC ?? 0) >= 26;
  if (!c.bike && !c.run && !hot) return undefined;
  return {
    terrain: perKm > 12 ? 'hilly' : perKm > 6 ? 'rolling' : 'flat',
    climbMin: climbs.slice(0, 5).map((x) => x.min),
    climbFrac: plan && p.ftp && climbs.length ? Math.round((climbs.reduce((t, x) => t + x.watts, 0) / climbs.length / p.ftp) * 100) / 100 : (bikeSpec?.frac ?? 0.85) * 1.08,
    runHilly: !!c.run && c.run.gain / c.run.km > 10,
    hot,
  };
}
