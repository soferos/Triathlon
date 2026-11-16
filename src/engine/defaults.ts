import type { Availability, Profile } from './types.ts';

export const defaultProfile = (): Profile => ({
  name: '',
  bikeTarget: 'power',
  runTarget: 'power',
  maxWeeklyHours: 14,
  currentWeeklyHours: 6,
  limiter: 'none',
  ramp: 'moderate',
  recoveryCycle: 'auto',
  restDay: true,
  comeback: { active: true, weeksOff: 8 },
  strengthEquipment: 'gym',
  autoThresholds: true,
  autoAdapt: false,
});

/** No daily limits: the plan lays out its best week first; the athlete then constrains what they must. */
export const defaultAvailability = (): Availability => ({
  days: Array.from({ length: 7 }, () => ({ minutes: null, pool: true, gym: true })),
  fixed: {},
  overrides: {},
});

/** Minutes a day can hold: a date-specific exception, else the weekly limit, else effectively unlimited. */
export const UNLIMITED = 600;
export function dayCap(a: Availability, date: string, weekday: number): number {
  return a.overrides[date]?.minutes ?? a.days[weekday].minutes ?? UNLIMITED;
}
