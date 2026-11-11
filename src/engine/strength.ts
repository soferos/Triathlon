// Periodised strength programme for endurance athletes: anatomical adaptation -> maximal strength
// -> power -> in-season maintenance. Heavy, low-rep work is the point; this is not circuit training.
import type { Exercise, Phase, Profile, Workout } from './types.ts';

export type StrengthBlock = 'adaptation' | 'max' | 'power' | 'maintenance';

export const STRENGTH_BLOCKS: Record<StrengthBlock, { title: string; aim: string; dosing: string }> = {
  adaptation: {
    title: 'Anatomical adaptation',
    aim: 'Re-groove movement patterns and load tendons after time off before going heavy.',
    dosing: '2–3 sets × 8–12 reps, 3–4 reps in reserve, 60–90 s rest, controlled tempo.',
  },
  max: {
    title: 'Maximal strength',
    aim: 'Raise force capacity: better economy in running and cycling with no meaningful mass gain.',
    dosing: '3–4 sets × 3–6 reps at ≥85% 1RM (1–2 reps in reserve), 2–3 min rest, fast intent on every rep.',
  },
  power: {
    title: 'Power & reactive strength',
    aim: 'Convert strength to rate of force development and tendon stiffness.',
    dosing: 'Heavy lifts 2–3 × 3–4; jumps 3 × 5–6 maximal-quality contacts, full recovery.',
  },
  maintenance: {
    title: 'In-season maintenance',
    aim: 'Keep the strength you built with the least possible fatigue.',
    dosing: 'One session per week, 2 × 3–5 heavy reps on the main lifts. Never to failure.',
  },
};

export function strengthBlockFor(phase: Phase, loadIdx: number, comeback: boolean): StrengthBlock {
  if (phase === 'rebuild') return 'adaptation';
  if (phase === 'base') return loadIdx < 2 && !comeback ? 'adaptation' : 'max';
  if (phase === 'build') return loadIdx < 3 ? 'max' : 'power';
  if (phase === 'transition') return 'adaptation';
  return 'maintenance';
}

const E = (name: string, sets: string, load: string, note?: string): Exercise => ({ name, sets, load, note });

function lifts(block: StrengthBlock, variant: 'A' | 'B', gym: boolean): Exercise[] {
  const dose = {
    adaptation: { main: '3 × 10', acc: '2 × 12', load: 'RPE 6–7 (3–4 in reserve)' },
    max: { main: '4 × 4–5', acc: '3 × 6', load: '≥85% 1RM (1–2 in reserve)' },
    power: { main: '3 × 3', acc: '2 × 5', load: '85–90% 1RM, explosive intent' },
    maintenance: { main: '2 × 4', acc: '2 × 5', load: '85% 1RM, stop well short of failure' },
  }[block];
  const calf = E('Calf raise — straight knee, then bent knee', block === 'adaptation' ? '3 × 12 each' : '3 × 6–8 each', 'Heavy, 3 s lowering', 'Achilles and soleus capacity: the main protection for returning run volume');
  const shoulder = E('Band external rotation + scapular pull-apart', '2 × 15', 'Light band', 'Swimmer’s shoulder prehab');
  const plyo = block === 'power'
    ? [E('Pogo hops', '3 × 10', 'Bodyweight, minimal ground contact'), E(variant === 'A' ? 'Box jump' : 'Bounding', '3 × 5', 'Maximal intent, full recovery')]
    : [];
  if (variant === 'A') {
    return [
      ...plyo,
      E(gym ? 'Back squat (or trap-bar deadlift)' : 'Goblet / rear-foot-elevated squat', dose.main, dose.load),
      E(gym ? 'Bulgarian split squat' : 'Split squat with dumbbells', dose.acc + ' each', dose.load),
      E(gym ? 'Barbell hip thrust' : 'Single-leg hip thrust', dose.acc, dose.load),
      calf,
      E(gym ? 'Pull-up / lat pulldown' : 'Band lat pulldown / inverted row', dose.acc, dose.load, 'Catch and pull strength for the swim'),
      E('Pallof press + side plank', '2 × 10 / 2 × 40 s each', 'Anti-rotation control'),
    ];
  }
  return [
    ...plyo,
    E(gym ? 'Romanian deadlift' : 'Single-leg RDL with dumbbell', dose.main, dose.load),
    E(gym ? 'Step-up or single-leg press' : 'High step-up', dose.acc + ' each', dose.load),
    calf,
    E(gym ? 'Seated cable row / bent-over row' : 'Dumbbell row', dose.acc, dose.load),
    E(gym ? 'Overhead press' : 'Push-up (feet elevated)', dose.acc, dose.load),
    E('Copenhagen plank', '2 × 20–30 s each', 'Bodyweight', 'Adductor strength; reduces groin injury risk'),
    shoulder,
    E('Dead bug', '2 × 8 each', 'Slow, ribs down'),
  ];
}

export function strengthWorkout(block: StrengthBlock, variant: 'A' | 'B', p: Profile, dur = 45): Workout {
  const info = STRENGTH_BLOCKS[block];
  return {
    sport: 'strength', code: `strength.${block}.${variant}`, name: `Strength ${variant} · ${info.title}`,
    category: 'strength', hard: false, blocks: [],
    exercises: lifts(block, variant, p.strengthEquipment === 'gym'),
    description: `${info.aim} ${info.dosing}`,
    notes: 'Warm up with 5 min easy cardio and 2 ramp-up sets. Lift after (not before) a key endurance session, ideally 6+ h later, and take 20–30 g protein afterwards.',
    durationMin: dur, tss: Math.round(dur * (block === 'max' || block === 'power' ? 0.55 : 0.4)),
  };
}

export function strengthProgramme(p: Profile) {
  return (Object.keys(STRENGTH_BLOCKS) as StrengthBlock[]).map((b) => ({
    block: b, ...STRENGTH_BLOCKS[b],
    sessions: (['A', 'B'] as const).map((v) => strengthWorkout(b, v, p)),
  }));
}
