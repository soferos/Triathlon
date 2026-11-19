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
  ramp: 'conservative' | 'moderate' | 'aggressive' | 'learned';
  /** CTL points/week this athlete has sustained historically (set from history on each re-plan) */
  learnedRamp?: number;
  recoveryCycle: 'auto' | '3:1' | '2:1';
  restDay: boolean;
  /** planStart: the Monday the rebuild block began in this plan, used when resumedOn is not set */
  comeback: { active: boolean; weeksOff: number; resumedOn?: string; note?: string; planStart?: string };
  strengthEquipment: 'gym' | 'home';
  autoThresholds: boolean;
  /** Apply load/missed-session adaptations automatically after each sync instead of proposing them */
  autoAdapt: boolean;
  /** Which Intervals.icu fields feed the readiness check; 'auto' prefers the overnight ones when the watch provides them */
  recovery?: RecoveryPrefs;
}

export interface DayAvailability {
  /** Time limit for the day in minutes; null = no limit (the plan decides what the day should hold) */
  minutes: number | null;
  pool: boolean; gym: boolean;
}
/** Days of the week (Mon = 0) the athlete has fixed. Anything left unset is the plan's choice. */
export interface FixedDays {
  /** Swim on exactly these days (squad sessions, lane bookings) */
  swim?: number[];
  /** Strength only on these days */
  strength?: number[];
  longRide?: number;
  longRun?: number;
  rest?: number;
}
export interface Availability {
  /** Monday..Sunday */
  days: DayAvailability[];
  fixed?: FixedDays;
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
  course?: RaceCourse;
  /** Split times (seconds) that reach the athlete's target placing, e.g. last year's AG podium */
  podium?: { swim?: number; bike?: number; run?: number; total?: number };
  /** For a race already done: manual corrections, the thresholds held at the time, and whether it calibrates predictions */
  result?: RaceResult;
}
export interface RaceResult {
  /** Split overrides in seconds, keyed by leg label (Swim, Bike, Run, Run 1, Run 2); otherwise taken from that day's activities */
  manual?: Record<string, number>;
  /** Thresholds at the time of the race; default to what the activities recorded, then to today's */
  then?: { ftp?: number; runPaceSecPerKm?: number; cssSecPer100?: number };
  /** Use this race to calibrate future predictions (default true) */
  use?: boolean;
}
/** Race behaviour fitted from the athlete's own results, replacing the generic assumptions */
export interface RaceModel {
  cda?: number;
  /** Fraction of threshold held per leg label, per race type */
  fracs: Partial<Record<RaceType, Record<string, number>>>;
  /** Names of the races the model was fitted from */
  sources: string[];
}

export interface Climb { startKm: number; km: number; gain: number; grade: number }
export interface CourseLeg {
  km: number;
  gain: number;
  /** Downsampled elevation profile: distance (km), elevation (m) */
  profile: [number, number][];
  climbs: Climb[];
}
export interface RaceCourse {
  bike?: CourseLeg;
  run?: CourseLeg;
  /** Aerodynamic drag area in race position (m^2) and bike + kit weight (kg) */
  cda?: number;
  bikeKg?: number;
  tempC?: number;
  transitionMin?: number;
  wetsuit?: boolean;
}
/** What the target course asks for, used to shape specific-phase training */
export interface CourseDemands {
  terrain: 'flat' | 'rolling' | 'hilly';
  /** Durations (min) of the main climbs at race power, longest first */
  climbMin: number[];
  /** Climb power as a fraction of FTP */
  climbFrac: number;
  runHilly: boolean;
  hot: boolean;
}

export interface Execution {
  verdict: 'nailed' | 'over' | 'under' | 'cut short' | 'unstructured';
  plannedReps: number; doneReps: number;
  /** Planned and achieved intensity as fractions of threshold */
  lo: number; hi: number; avg?: number;
  /** Change in intensity from first to last rep, % */
  fade?: number;
  text: string;
}

export interface Niggle {
  id: string; date: string; area: string;
  sport: 'run' | 'bike' | 'swim';
  /** 1 = aware of it, 2 = alters how I move, 3 = painful */
  severity: 1 | 2 | 3;
  note?: string;
  resolved?: string;
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
    /** Aerobic decoupling (%) and interval-by-interval execution, when Intervals.icu provides them */
    decoupling?: number; exec?: Execution;
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
  course?: CourseDemands;
  /** Weeks until the target race (0 = race week) */
  weeksOut?: number;
  focus: string;
}

export interface Wellness {
  date: string;
  ctl?: number; atl?: number;
  hrv?: number; restingHR?: number;
  /** SDNN HRV (ms) and the average heart rate during sleep (bpm), where the source provides them */
  hrvSDNN?: number; avgSleepingHR?: number;
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
  /** Aerobic decoupling, % (power or pace vs heart rate, first half vs second half) */
  decoupling?: number;
  /** Exact moving time (s), local start time (HH:MM:SS), and the FTP Intervals.icu held for this activity */
  secs?: number; time?: string; ftp?: number;
}

export interface RecoveryPrefs { rhr: 'auto' | 'resting' | 'sleeping'; hrv: 'auto' | 'rmssd' | 'sdnn' }
