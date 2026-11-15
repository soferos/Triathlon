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

export const defaultAvailability = (): Availability => ({
  days: [
    { minutes: 60, pool: true, gym: true },
    { minutes: 90, pool: true, gym: true },
    { minutes: 120, pool: true, gym: true },
    { minutes: 90, pool: true, gym: true },
    { minutes: 60, pool: true, gym: true },
    { minutes: 300, pool: false, gym: false },
    { minutes: 180, pool: false, gym: false },
  ],
  overrides: {},
});
