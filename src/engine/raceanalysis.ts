// Past-race analysis: links a completed race to the activities recorded that day, compares what
// happened with what the model would have predicted, and fits the athlete's own race behaviour
// (effective CdA, fraction of threshold held on each leg) for use in future predictions.
import type { Activity, Profile, Race, RaceModel, Sport } from './types.ts';
import { bikePlan, predictRace, raceLegs, runSecs } from './course.ts';

export interface LegResult {
  sport: Sport; label: string; km: number;
  /** Actual split and where it came from */
  secs: number | null; source: 'manual' | 'activity' | 'missing'; activity?: string;
  /** What the generic model predicted with the thresholds held at the time */
  modelled: number | null;
  /** Fraction of threshold actually held, and the generic assumption it replaces */
  frac: number | null; defaultFrac: number;
  np?: number; avgHr?: number;
  note: string;
}
export interface RaceAnalysis {
  legs: LegResult[];
  total: number | null; modelledTotal: number | null;
  /** Effective CdA that reproduces the bike split at the power actually ridden */
  cda: number | null;
  then: { ftp?: number; runPaceSecPerKm?: number; cssSecPer100?: number; source: string };
  /** Usable for calibration: enabled by the athlete and physically plausible */
  usable: boolean;
  /** The same course raced today on current thresholds, with the personal model applied */
  today: number | null;
  notes: string[];
}

const PLAUSIBLE: Record<string, [number, number]> = { swim: [0.75, 1.15], bike: [0.5, 1.08], run: [0.65, 1.12] };
const secsOf = (a: Activity) => a.secs ?? a.durationMin * 60;

/** Pick the day's activity for each leg: right sport, plausible distance, in start-time order. */
function linkLegs(race: Race, activities: Activity[]) {
  const day = activities.filter((a) => a.date === race.date && (a.sport === 'swim' || a.sport === 'bike' || a.sport === 'run'))
    .sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
  const used = new Set<string>();
  return raceLegs(race.type).map((l) => {
    const km = l.sport === 'bike' ? race.course?.bike?.km ?? l.km : l.sport === 'run' && l.label !== 'Run 1' ? race.course?.run?.km ?? l.km : l.km;
    // A warm-up jog or spin is far shorter than the leg; anything from 60% to 150% of the distance qualifies.
    const cands = day.filter((a) => a.sport === l.sport && !used.has(a.id) && (!a.distanceKm || (a.distanceKm >= km * 0.6 && a.distanceKm <= km * 1.5)));
    const pick = cands[0];
    if (pick) used.add(pick.id);
    return { spec: l, km, activity: pick };
  });
}

export function analyzeRace(race: Race, activities: Activity[], p: Profile, model?: RaceModel): RaceAnalysis | null {
  const specs = raceLegs(race.type);
  if (!specs.length) return null;
  const linked = linkLegs(race, activities);
  const res = race.result ?? {};
  const bikeAct = linked.find((l) => l.spec.sport === 'bike')?.activity;
  const then = {
    ftp: res.then?.ftp ?? bikeAct?.ftp ?? p.ftp,
    runPaceSecPerKm: res.then?.runPaceSecPerKm ?? p.runPaceSecPerKm,
    cssSecPer100: res.then?.cssSecPer100 ?? p.cssSecPer100,
    source: res.then && Object.values(res.then).some(Boolean) ? 'as you entered them' : bikeAct?.ftp ? 'FTP from the race activity; run and swim thresholds are today’s' : 'today’s thresholds (enter the ones you held then for a truer picture)',
  };
  const pThen: Profile = { ...p, ftp: then.ftp, runPaceSecPerKm: then.runPaceSecPerKm, cssSecPer100: then.cssSecPer100 };
  const generic = predictRace(race, pThen);
  const notes: string[] = [];
  let cda: number | null = null;

  const legs: LegResult[] = linked.map(({ spec, km, activity }, i) => {
    const manual = res.manual?.[spec.label];
    const secs = manual ?? (activity ? secsOf(activity) : null);
    const base = {
      sport: spec.sport, label: spec.label, km, secs, source: (manual ? 'manual' : activity ? 'activity' : 'missing') as LegResult['source'],
      activity: activity?.name, modelled: generic?.legs[i]?.secs ?? null, defaultFrac: spec.frac, np: activity?.np, avgHr: activity?.avgHr,
    };
    if (!secs) return { ...base, frac: null, note: 'No split: enter it, or re-import your history if the activity exists in Intervals.icu.' };
    if (spec.sport === 'swim') {
      if (!then.cssSecPer100) return { ...base, frac: null, note: 'Needs your CSS.' };
      const frac = (km * 10 * then.cssSecPer100) / secs / (race.course?.wetsuit ? 1.03 : 1);
      return { ...base, frac, note: `${Math.round(frac * 100)}% of CSS${race.course?.wetsuit ? ' (wetsuit allowed for)' : ''}` };
    }
    if (spec.sport === 'bike') {
      if (!then.ftp || !activity?.np) return { ...base, frac: null, note: activity ? 'The activity has no power data, so intensity and CdA cannot be fitted.' : 'Without the activity’s power, intensity and CdA cannot be fitted.' };
      const frac = activity.np / then.ftp;
      // Fit CdA: the drag area at which the model, ridden at the actual normalised power, gives the actual split.
      const at = (c: number) => bikePlan(km, race.course?.bike, frac, pThen, { ...race, course: { ...race.course, cda: c } })!.secs;
      if (at(0.12) < secs && at(0.5) > secs) {
        let lo = 0.12, hi = 0.5;
        for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (at(mid) < secs) lo = mid; else hi = mid; }
        cda = Math.round(((lo + hi) / 2) * 1000) / 1000;
      } else notes.push('The bike split cannot be reproduced with any realistic CdA at the recorded power — check the course distance, the split, or whether drafting, wind or a mechanical was involved.');
      return { ...base, frac, note: `NP ${Math.round(activity.np)} W = ${Math.round(frac * 100)}% of FTP ${Math.round(then.ftp)} W${race.course?.bike ? '' : ' · flat course assumed'}` };
    }
    if (!then.runPaceSecPerKm) return { ...base, frac: null, note: 'Needs your run threshold pace.' };
    const leg = spec.label === 'Run 1' ? undefined : race.course?.run;
    // Grade-adjusted: the fraction of threshold speed that gives this time on this course.
    const frac = runSecs(km, leg, 1, pThen)! / secs;
    return { ...base, frac, note: `${Math.round(frac * 100)}% of threshold pace${leg ? ', grade-adjusted' : ''}` };
  });

  for (const l of legs) {
    if (l.frac == null) continue;
    const [lo, hi] = PLAUSIBLE[l.sport];
    if (l.frac < lo || l.frac > hi) {
      notes.push(`${l.label}: ${Math.round(l.frac * 100)}% of threshold is outside what is physically plausible for a race, so it is not used for calibration. The distance, the split or the threshold at the time is probably off.`);
      l.frac = null;
    }
  }
  if (cda != null && !race.course?.bike) notes.push('CdA was fitted assuming a flat bike course. Upload the bike GPX for a figure you can rely on.');
  if (cda != null) notes.push('The fitted CdA is an effective figure: it also absorbs wind, drafting, braking and rolling resistance on the day.');
  const total = res.manual?.Total ?? (legs.every((l) => l.secs) ? legs.reduce((t, l) => t + l.secs!, 0) + (generic?.transitions ?? 0) : null);
  const usable = res.use !== false && legs.some((l) => l.frac != null);
  return {
    legs, total, modelledTotal: generic?.total ?? null, cda, then, usable,
    today: predictRace(race, p, model)?.total ?? null, notes,
  };
}

/**
 * The athlete's personal race model: for each race type the fractions held in the most recent
 * analysed race of that type, and the most recently fitted CdA.
 */
export function personalModel(races: Race[], activities: Activity[], p: Profile, today: string): RaceModel | undefined {
  const model: RaceModel = { fracs: {}, sources: [] };
  const past = races.filter((r) => r.date < today).sort((a, b) => a.date.localeCompare(b.date));
  for (const r of past) {
    const a = analyzeRace(r, activities, p);
    if (!a?.usable) continue;
    const f: Record<string, number> = {};
    for (const l of a.legs) if (l.frac != null) f[l.label] = Math.round(l.frac * 1000) / 1000;
    if (Object.keys(f).length) model.fracs[r.type] = { ...model.fracs[r.type], ...f };
    if (a.cda != null && r.course?.bike) model.cda = a.cda;
    model.sources.push(r.name);
  }
  return model.sources.length ? model : undefined;
}
