// Core domain types. Kept free of runtime code so every module can `import type` from here.

export type Sport = 'swim' | 'bike' | 'run' | 'strength' | 'race';
export type Phase = 'rebuild' | 'base' | 'build' | 'specific' | 'taper' | 'race' | 'transition';
export type RaceType =
  | 'sprint' | 'olympic' | 'half' | 'full'
  | 'duathlonSprint' | 'duathlon' | 'aquathlon'
  | 'run10k' | 'halfMarathon' | 'marathon' | 'bikeEvent' | 'other';
export type TriDistance = 'sprint' | 'olympic' | 'half' | 'full';
export type Priority = 'A' | 'B' | 'C';
export type Category =
  | 'recovery' | 'endurance' | 'tempo' | 'threshold' | 'vo2' | 'speed'
  | 'racepace' | 'test' | 'technique' | 'strength' | 'race';

export interface Profile {
  name: string;
  birthYear?: number;
  sex?: 'm' | 'f';
  weightKg?: number;
  /** Bike functional threshold power, W */
  ftp?: number;
  bikeLthr?: number;
  /** Run threshold / critical power, W (Stryd, Apple Watch, Garmin...) */
  runPower?: number;
  /** Run threshold pace, seconds per km */
  runPaceSecPerKm?: number;
  runLthr?: number;
  /** Critical swim speed, seconds per 100 m */
  cssSecPer100?: number;
  bikeTarget: 'power' | 'hr';
  runTarget: 'power' | 'pace' | 'hr';
  maxWeeklyHours: number;
  /** Average weekly training hours over the last ~4 weeks; seeds fitness when no Intervals.icu data */
  currentWeeklyHours: number;
  limiter: 'none' | 'swim' | 'bike' | 'run';
  ramp: 'conservative' | 'moderate' | 'aggressive';
  recoveryCycle: 'auto' | '3:1' | '2:1';
  restDay: boolean;
  comeback: { active: boolean; weeksOff: number; resumedOn?: string; note?: string };
  strengthEquipment: 'gym' | 'home';
  autoThresholds: boolean;
  /** Apply load/missed-session adaptations automatically after each sync instead of proposing them */
  autoAdapt: boolean;
}

export interface DayAvailability { minutes: number; pool: boolean; gym: boolean }
export interface Availability {
  /** Monday..Sunday */
  days: DayAvailability[];
  /** Date-specific overrides (travel, work, illness): ISO date -> minutes */
  overrides: Record<string, { minutes: number; note?: string }>;
}

export interface Race {
  id: string;
  name: string;
  date: string;
  type: RaceType;
  priority: Priority;
  goal?: string;
  notes?: string;
}

export interface Goal {
  id: string;
  title: string;
  category: 'performance' | 'health' | 'skill' | 'life';
  horizon: 'season' | 'long-term';
  metric?: string;
  target?: string;
  due?: string;
  status: 'active' | 'achieved' | 'parked';
}

export interface Step {
  kind: 'warmup' | 'work' | 'recovery' | 'cooldown' | 'rest';
  /** Exactly one of secs / meters drives the step; swim steps use meters */
  secs?: number;
  meters?: number;
  /** Intensity as a fraction of the sport threshold (FTP, run threshold power/speed, CSS speed) */
  lo: number;
  hi: number;
  ramp?: boolean;
  cadence?: number;
  cue?: string;
}
export interface Block { name: string; repeat: number; steps: Step[] }

export interface Exercise { name: string; sets: string; load: string; note?: string }

export interface Workout {
  code: string;
  sport: Sport;
  name: string;
  category: Category;
  hard: boolean;
  blocks: Block[];
  exercises?: Exercise[];
  description: string;
  /** Fueling / execution notes */
  notes?: string;
  durationMin: number;
  tss: number;
  custom?: boolean;
}

export type Role = 'long' | 'key' | 'easy' | 'brick' | 'race' | 'test' | 'strength' | 'opener';

export interface Session {
  id: string;
  date: string;
  sport: Sport;
  role: Role;
  workout: Workout;
  status: 'planned' | 'done' | 'skipped';
  /** Locked sessions survive plan regeneration (user-edited, custom, or completed) */
  locked: boolean;
  origin: 'plan' | 'custom' | 'adapted';
  /** What was actually done, from the matched Intervals.icu activity */
  actual?: {
    tss?: number; durationMin?: number; activityId?: string; name?: string;
    distanceKm?: number; np?: number; avgHr?: number; intensity?: number;
    /** Set when the session was done on a different day than planned */
    plannedDate?: string;
  };
  adaptedNote?: string;
}

export interface SeasonWeek {
  start: string;
  phase: Phase;
  /** Number of load weeks already completed in this phase block (drives progression) */
  loadIdx: number;
  recovery: boolean;
  testWeek: boolean;
  targetTss: number;
  targetHours: number;
  ctlEnd: number;
  races: Race[];
  /** The race this block is building towards */
  targetRaceId?: string;
  targetType: TriDistance;
  /** Actual type of the race being built towards (duathlon / aquathlon shift the discipline mix) */
  targetRace?: RaceType;
  focus: string;
}

export interface Wellness {
  date: string;
  ctl?: number; atl?: number;
  hrv?: number; restingHR?: number;
  sleepSecs?: number; sleepScore?: number;
  soreness?: number; fatigue?: number; stress?: number; mood?: number; motivation?: number;
  weight?: number;
}

export interface Checkin {
  date: string;
  /** 1 (great) .. 5 (terrible) */
  fatigue?: number; soreness?: number; stress?: number;
  sleepHours?: number;
  symptoms?: boolean;
  note?: string;
}

export interface Activity {
  id: string; date: string; sport: Sport | 'other'; name: string;
  durationMin: number; tss: number; distanceKm?: number;
  /** Raw Intervals.icu activity type, e.g. VirtualRide, TrailRun, NordicSki */
  type?: string;
  /** Normalised power (W), average HR (bpm), intensity factor (0..1.x) when available */
  np?: number; avgHr?: number; intensity?: number;
}
