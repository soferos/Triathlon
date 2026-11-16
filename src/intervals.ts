// Intervals.icu client. Personal API-key auth is HTTP Basic with the literal username "API_KEY".
// Planned workouts pushed to the Intervals.icu calendar are what reach the watch / head unit /
// trainer apps (Garmin, Wahoo, Suunto, COROS, Zwift ... and Apple Watch via a companion app).
import type { Activity, Profile, Race, Session, Sport, Wellness } from './engine/types.ts';
import { finalize, toIcuText } from './engine/zones.ts';

const EXT_PREFIX = 'tricoach-';

export class IntervalsError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const SPORT_OF: Record<string, Sport> = {
  Ride: 'bike', VirtualRide: 'bike', GravelRide: 'bike', MountainBikeRide: 'bike', EBikeRide: 'bike', EMountainBikeRide: 'bike',
  TrackRide: 'bike', Velomobile: 'bike', Handcycle: 'bike',
  Run: 'run', VirtualRun: 'run', TrailRun: 'run', Treadmill: 'run',
  Swim: 'swim', OpenWaterSwim: 'swim',
  WeightTraining: 'strength', Workout: 'strength', Crossfit: 'strength', HighIntensityIntervalTraining: 'strength',
};
const TYPE_OF: Record<string, string> = { bike: 'Ride', run: 'Run', swim: 'Swim', strength: 'WeightTraining' };

export class Intervals {
  base: string; key: string; athlete: string;
  constructor(apiKey: string, athleteId?: string, base = process.env.INTERVALS_BASE_URL || 'https://intervals.icu') {
    this.key = apiKey.trim();
    // "0" resolves to the athlete that owns the API key.
    this.athlete = (athleteId || '0').trim();
    this.base = base.replace(/\/$/, '');
  }

  async req(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`API_KEY:${this.key}`).toString('base64')}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e: any) {
      throw new IntervalsError(0, `Could not reach Intervals.icu (${e?.cause?.code || e?.message || 'network error'}).`);
    }
    if (res.status === 401 || res.status === 403) throw new IntervalsError(res.status, 'Intervals.icu rejected the credentials. Check the API key and athlete ID (Settings → Developer Settings).');
    if (!res.ok) throw new IntervalsError(res.status, `Intervals.icu ${method} ${path.split('?')[0]} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  athleteInfo() { return this.req('GET', `/athlete/${this.athlete}`); }

  async wellness(oldest: string, newest: string): Promise<Wellness[]> {
    const rows = await this.req('GET', `/athlete/${this.athlete}/wellness?oldest=${oldest}&newest=${newest}`);
    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return (rows ?? []).map((r: any) => ({
      date: r.id, ctl: num(r.ctl), atl: num(r.atl), hrv: num(r.hrv), restingHR: num(r.restingHR),
      sleepSecs: num(r.sleepSecs), sleepScore: num(r.sleepScore), soreness: num(r.soreness), fatigue: num(r.fatigue),
      stress: num(r.stress), mood: num(r.mood), motivation: num(r.motivation), weight: num(r.weight),
    }));
  }

  /**
   * Activities in a date range. `hidden` counts activities Intervals.icu knows about but may not
   * hand out over its API: anything that reached it via Strava comes back as a stub with no data
   * (Strava's API terms), so those can only be counted, not imported.
   */
  async activities(oldest: string, newest: string): Promise<{ list: Activity[]; hidden: number }> {
    const rows: any[] = (await this.req('GET', `/athlete/${this.athlete}/activities?oldest=${oldest}&newest=${newest}`)) ?? [];
    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
    const isStub = (r: any) => r?.source === 'STRAVA' && !r.type && !r.moving_time;
    const list = rows.filter((r) => r?.start_date_local && !isStub(r)).map((r) => {
      // icu_intensity is reported as a percentage (e.g. 78.5); normalise to a fraction.
      const i = num(r.icu_intensity);
      return {
        id: String(r.id), date: String(r.start_date_local).slice(0, 10), sport: SPORT_OF[r.type] ?? 'other',
        type: r.type ? String(r.type) : undefined,
        name: r.name ?? r.type ?? 'Activity', durationMin: Math.round((r.moving_time ?? r.elapsed_time ?? 0) / 60),
        tss: Math.round(r.icu_training_load ?? 0), distanceKm: r.distance ? Math.round(r.distance / 10) / 100 : undefined,
        np: num(r.icu_weighted_avg_watts), avgHr: num(r.average_heartrate),
        intensity: i ? Math.round(i > 3 ? i : i * 100) / 100 : undefined,
        decoupling: typeof r.decoupling === 'number' && Number.isFinite(r.decoupling) ? Math.round(r.decoupling * 10) / 10 : undefined,
      } as Activity;
    });
    return { list, hidden: rows.filter(isStub).length };
  }

  /** Intervals Intervals.icu detected in one activity (laps or auto-detected work/recovery). */
  async activityIntervals(activityId: string): Promise<any[]> {
    const r = await this.req('GET', `/activity/${encodeURIComponent(activityId)}/intervals`);
    return Array.isArray(r) ? r : Array.isArray(r?.icu_intervals) ? r.icu_intervals : [];
  }

  events(oldest: string, newest: string): Promise<any[]> {
    return this.req('GET', `/athlete/${this.athlete}/events?oldest=${oldest}&newest=${newest}`).then((r) => r ?? []);
  }

  /** Upsert planned sessions as calendar workouts and remove events of ours that no longer exist in the plan. */
  async pushSessions(sessions: Session[], p: Profile, oldest: string, newest: string) {
    const wanted = sessions.filter((x) => x.date >= oldest && x.date <= newest && x.status === 'planned' && TYPE_OF[x.sport]);
    const payload = wanted.map((x) => {
      const w = finalize(x.workout, p);
      return {
        category: 'WORKOUT',
        start_date_local: `${x.date}T00:00:00`,
        type: TYPE_OF[x.sport],
        name: w.name,
        description: toIcuText(w, p),
        moving_time: w.durationMin * 60,
        external_id: EXT_PREFIX + x.id,
      };
    });
    if (payload.length) await this.req('POST', `/athlete/${this.athlete}/events/bulk?upsert=true`, payload);
    const keep = new Set(payload.map((e) => e.external_id));
    const existing = await this.events(oldest, newest);
    let removed = 0;
    for (const e of existing) {
      if (typeof e.external_id === 'string' && e.external_id.startsWith(EXT_PREFIX) && !keep.has(e.external_id)) {
        await this.req('DELETE', `/athlete/${this.athlete}/events/${e.id}`);
        removed++;
      }
    }
    return { pushed: payload.length, removed };
  }
}

/** Pull thresholds out of the athlete's sport settings. Intervals.icu stores threshold pace in m/s. */
export function thresholdsFrom(athlete: any): Partial<Profile> {
  const out: Partial<Profile> = {};
  const settings: any[] = athlete?.sportSettings ?? [];
  const find = (t: string) => settings.find((s) => Array.isArray(s.types) && s.types.includes(t));
  const pos = (v: any) => (typeof v === 'number' && v > 0 ? v : undefined);
  const ride = find('Ride'), runS = find('Run'), swimS = find('Swim');
  if (ride) { out.ftp = pos(ride.ftp); out.bikeLthr = pos(ride.lthr); }
  if (runS) {
    out.runPower = pos(runS.ftp); out.runLthr = pos(runS.lthr);
    const v = pos(runS.threshold_pace);
    if (v && v > 1.5 && v < 8) out.runPaceSecPerKm = Math.round(1000 / v);
  }
  if (swimS) {
    const v = pos(swimS.threshold_pace);
    if (v && v > 0.4 && v < 2.6) out.cssSecPer100 = Math.round(100 / v);
  }
  if (pos(athlete?.icu_weight)) out.weightKg = athlete.icu_weight;
  for (const k of Object.keys(out) as (keyof Profile)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Races already on the Intervals.icu calendar (categories RACE_A / RACE_B / RACE_C). */
export function racesFrom(events: any[]): Omit<Race, 'id'>[] {
  return events.filter((e) => typeof e.category === 'string' && /^RACE_[ABC]$/.test(e.category)).map((e) => ({
    name: e.name || 'Race', date: String(e.start_date_local).slice(0, 10),
    type: e.type === 'Run' ? 'halfMarathon' : e.type === 'Ride' ? 'bikeEvent' : 'olympic',
    priority: e.category.slice(-1) as Race['priority'],
    notes: 'Imported from Intervals.icu — check the race type.',
  }));
}
