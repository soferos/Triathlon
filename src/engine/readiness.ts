// Daily readiness: combines HRV, resting HR, sleep, subjective state and form into one decision —
// train as planned, adjust, or recover. HRV logic follows the rolling-baseline approach used in
// HRV-guided training studies (7-day mean vs. the athlete's own normal range).
import type { Checkin, Wellness } from './types.ts';

export interface Signal { key: string; label: string; value: string; status: 'good' | 'ok' | 'warn' | 'bad'; detail: string }
export interface Readiness {
  status: 'go' | 'adjust' | 'recover' | 'unknown';
  score: number | null;
  headline: string;
  advice: string;
  signals: Signal[];
}

const mean = (a: number[]) => a.reduce((t, x) => t + x, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

export function assessReadiness(today: string, wellness: Wellness[], checkin?: Checkin): Readiness {
  const hist = wellness.filter((w) => w.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  const signals: Signal[] = [];
  let penalty = 0;
  let forced: 'recover' | undefined;

  // --- HRV: 7-day rolling ln(rMSSD) against the 60-day normal band (mean ± 0.5 SD) ---
  const hrv = hist.filter((w) => w.hrv && w.hrv > 0).slice(-60).map((w) => Math.log(w.hrv!));
  if (hrv.length >= 14) {
    const base = mean(hrv), band = Math.max(sd(hrv) * 0.5, 0.02);
    const recent = mean(hrv.slice(-7)), last = hrv.at(-1)!;
    const z = (recent - base) / (band * 2);
    let status: Signal['status'] = 'good', detail = '7-day average inside your normal range.';
    if (recent < base - band) {
      status = last < base - band * 2 ? 'bad' : 'warn';
      penalty += status === 'bad' ? 30 : 18;
      detail = 'Suppressed below your normal range: autonomic stress is accumulating.';
    } else if (last < base - band * 2) {
      status = 'ok'; penalty += 8; detail = 'Single low reading; trend still normal.';
    } else if (recent > base + band * 2.5) {
      status = 'ok'; penalty += 5; detail = 'Unusually high — can accompany deep fatigue. Cross-check how you feel.';
    }
    signals.push({ key: 'hrv', label: 'HRV', value: `${Math.round(Math.exp(last))} ms (7d ${Math.round(Math.exp(recent))}, base ${Math.round(Math.exp(base))})`, status, detail: `${detail} (z ${z.toFixed(1)})` });
  }

  // --- Resting HR ---
  const rhr = hist.filter((w) => w.restingHR && w.restingHR > 0).slice(-60).map((w) => w.restingHR!);
  if (rhr.length >= 10) {
    const base = mean(rhr.slice(0, -1)), last = rhr.at(-1)!;
    const delta = last - base;
    const status: Signal['status'] = delta >= 7 ? 'bad' : delta >= 4 ? 'warn' : 'good';
    penalty += delta >= 7 ? 22 : delta >= 4 ? 10 : 0;
    signals.push({ key: 'rhr', label: 'Resting HR', value: `${Math.round(last)} bpm (${delta >= 0 ? '+' : ''}${delta.toFixed(0)})`, status, detail: delta >= 4 ? 'Elevated versus baseline: incomplete recovery, heat, dehydration or oncoming illness.' : 'At baseline.' });
  }

  // --- Sleep ---
  const lastW = hist.at(-1);
  const sleepH = checkin?.sleepHours ?? (lastW?.date === today && lastW.sleepSecs ? lastW.sleepSecs / 3600 : undefined);
  if (sleepH != null) {
    const status: Signal['status'] = sleepH < 5.5 ? 'bad' : sleepH < 6.5 ? 'warn' : sleepH < 7.5 ? 'ok' : 'good';
    penalty += sleepH < 5.5 ? 20 : sleepH < 6.5 ? 10 : 0;
    signals.push({ key: 'sleep', label: 'Sleep', value: `${sleepH.toFixed(1)} h`, status, detail: sleepH < 6.5 ? 'Short sleep blunts adaptation and raises injury/illness risk.' : 'Adequate.' });
  }

  // --- Form (TSB) relative to fitness ---
  if (lastW?.ctl != null && lastW.atl != null && lastW.ctl > 0) {
    const tsb = lastW.ctl - lastW.atl;
    const rel = tsb / lastW.ctl;
    const status: Signal['status'] = rel < -0.4 ? 'bad' : rel < -0.25 ? 'warn' : 'good';
    penalty += rel < -0.4 ? 20 : rel < -0.25 ? 8 : 0;
    signals.push({ key: 'form', label: 'Form', value: `${tsb.toFixed(0)} (fitness ${lastW.ctl.toFixed(0)}, fatigue ${lastW.atl.toFixed(0)})`, status, detail: rel < -0.4 ? 'Deep in the hole relative to your fitness. Productive only if planned and short-lived.' : rel < -0.25 ? 'Carrying real fatigue relative to your fitness. Normal late in a loading week; watch the trend.' : 'Fatigue is proportionate to fitness.' });
  }

  // --- Subjective (check-in 1..5, or Intervals.icu wellness 1..4) ---
  const subj: number[] = [];
  if (checkin) {
    for (const v of [checkin.fatigue, checkin.soreness, checkin.stress]) if (v) subj.push((v - 1) / 4);
  } else if (lastW?.date === today) {
    for (const v of [lastW.fatigue, lastW.soreness, lastW.stress]) if (v) subj.push((v - 1) / 3);
  }
  if (subj.length) {
    const worst = Math.max(...subj), avg = mean(subj);
    const status: Signal['status'] = worst >= 1 ? 'bad' : avg >= 0.6 ? 'warn' : avg >= 0.4 ? 'ok' : 'good';
    penalty += worst >= 1 ? 22 : avg >= 0.6 ? 14 : avg >= 0.4 ? 5 : 0;
    signals.push({ key: 'feel', label: 'How you feel', value: `${Math.round((1 - avg) * 100)}%`, status, detail: status === 'good' ? 'Feeling good.' : 'Subjective fatigue is one of the most reliable overreaching markers — respect it.' });
  }
  if (checkin?.symptoms) {
    forced = 'recover';
    signals.push({ key: 'symptoms', label: 'Symptoms', value: 'reported', status: 'bad', detail: 'Illness symptoms: no intensity until 48 h symptom-free; nothing at all with fever or chest symptoms.' });
  }

  if (!signals.length) {
    return { status: 'unknown', score: null, headline: 'No readiness data yet', advice: 'Connect Intervals.icu (HRV, resting HR, sleep) or log a check-in. Until then: train as planned.', signals };
  }
  const score = forced ? Math.min(30, Math.max(0, 100 - penalty)) : Math.max(0, 100 - penalty);
  const status = forced ?? (score >= 75 ? 'go' : score >= 50 ? 'adjust' : 'recover');
  const text = {
    go: ['Green light', 'Execute today as written. Hit the targets, not more.'],
    adjust: ['Adjust today', 'Two or more recovery markers are off. Keep the volume aerobic and move the quality to a day you can actually absorb it.'],
    recover: ['Recover today', 'Your body is not in a state to adapt to hard training. Easy spin, walk or full rest; sleep and eat. One day lost here saves a week later.'],
  }[status];
  return { status, score, headline: text[0], advice: text[1], signals };
}

/** Foster's training monotony and strain over the last 7 days of daily loads. */
export function monotony(dailyLoads: number[]) {
  if (dailyLoads.length < 7) return null;
  const wk = dailyLoads.slice(-7);
  const s = sd(wk);
  const m = s > 0 ? mean(wk) / s : 0;
  return { monotony: Math.round(m * 100) / 100, strain: Math.round(m * wk.reduce((t, x) => t + x, 0)) };
}
