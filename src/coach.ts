// AI coach: a Claude-backed conversation that can explain the plan and change it through tools.
// The conversation is stored server-side and replayed append-only (thinking blocks included),
// so the API key and raw message history never reach the browser.
import type Anthropic from '@anthropic-ai/sdk';
import { addDays, diffDays, DAY_NAMES, dow, mondayOf } from './engine/dates.ts';
import { assessReadiness } from './engine/readiness.ts';
import { summarizeHistory } from './engine/history.ts';
import { currentCtl, customWorkout, generate, uid, type State } from './engine/plan.ts';
import { finalize, toIcuText, zoneTable } from './engine/zones.ts';
import type { Session } from './engine/types.ts';



export const COACH_MODEL = process.env.COACH_MODEL || 'claude-opus-5-5';
const MAX_TURNS = 12;

export class CoachError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const SYSTEM = `You are the coach inside a triathlon training app used by one athlete. You are talking to that athlete.

Who they are: an advanced age-group triathlete close to the top of their age group, returning from a health-related break. Talk to them as a peer who knows the sport. Do not explain basics unless asked, do not pad answers with encouragement, and do not hedge every statement. Give your actual view, including when you disagree with what they want to do, and say what you would do instead.

How the app plans, so your advice stays consistent with it:
- The season is periodised backwards from A-races: rebuild (return to training), base, build, specific, taper, race, transition. B-races get a short freshen-up, C-races are trained through.
- Weekly load targets come from chronic training load (CTL) with a ramp of roughly 3-5 CTL points per week, a recovery week every third or fourth week, and threshold tests at the end of selected recovery weeks.
- Intensity is a fraction of the sport's threshold: bike = fraction of FTP; run = fraction of threshold power (or threshold speed); swim = fraction of critical swim speed. Run and swim zones are much narrower than bike zones: easy running is about 0.78-0.87, run threshold 0.96-1.03, run VO2max 1.04-1.15; easy bike is 0.56-0.75, sweet spot 0.88-0.94, bike threshold 0.95-1.05, bike VO2max 1.06-1.20; swim aerobic 0.87-0.94, CSS 0.95-1.02.
- Load is estimated as hours x IF squared x 100 per session.
- Each message from the athlete starts with a <context> block: a snapshot the app generates of the profile, season, the next two weeks of sessions (with ids), recent training and readiness. It is data from the app, not something the athlete typed. Use the tools when you need more than the snapshot holds (older history, a session's full step list, weeks further out).

Changing the plan:
- You can move, skip, replace, add and delete sessions, set availability for specific dates, and re-plan. Use these when the athlete asks for a change or agrees to one you proposed. For a question ("why is this session here?", "what is this for?"), answer it and change nothing.
- When they ask for a change and the request is clear, make it; do not ask for permission you already have. If it conflicts with something that matters (two hard days back to back, a key session the day before a long run, intensity during the rebuild block, load well above the week's target), say so in a sentence and still follow their decision if they insist.
- When you replace or add a workout, write complete structured steps with a warm-up and cool-down, using the intensity fractions above. Keep to the athlete's available time on that day when it is shown.
- A change you make is pinned, so automatic re-planning will not undo it. Changes are not sent to Intervals.icu or their watch until they press Push in the Plan view; mention that once after making changes.
- After changing something, say exactly what changed: which session, which day, and what it is now.

Health: the app does not know why they took the break. If they describe symptoms that could be cardiac, respiratory, a bone stress injury, or signs of low energy availability, say plainly that a doctor needs to look at it before intensity continues, and adjust the plan conservatively. Otherwise do not lecture about health.

Style: plain text only, since the app does not render markdown. Short paragraphs; use lines starting with "- " for lists. Give targets in the athlete's own units (watts, pace per km, pace per 100 m) when thresholds are known. Answer the question first, then the reasoning. Keep answers as short as the question allows.`;

const stepSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['warmup', 'work', 'recovery', 'cooldown', 'rest'] },
    secs: { type: 'number', description: 'Duration in seconds. Use for bike and run steps, and for rest steps in swims.' },
    meters: { type: 'number', description: 'Distance in metres. Swim steps only, instead of secs.' },
    lo: { type: 'number', description: 'Lower intensity bound as a fraction of threshold, e.g. 0.95. Use 0 for rest.' },
    hi: { type: 'number', description: 'Upper intensity bound as a fraction of threshold, e.g. 1.02.' },
    ramp: { type: 'boolean', description: 'True if intensity should ramp from lo to hi across the step.' },
    cue: { type: 'string', description: 'Short execution cue shown on the device, letters only.' },
  },
  required: ['kind', 'lo', 'hi'],
};
const workoutSchema = {
  type: 'object',
  description: 'A complete structured workout.',
  properties: {
    sport: { type: 'string', enum: ['swim', 'bike', 'run'] },
    name: { type: 'string' },
    description: { type: 'string', description: 'One or two sentences on the purpose and how to execute it.' },
    blocks: {
      type: 'array',
      description: 'Ordered blocks. A block with repeat > 1 is an interval set.',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, repeat: { type: 'integer' }, steps: { type: 'array', items: stepSchema } },
        required: ['name', 'repeat', 'steps'],
      },
    },
  },
  required: ['sport', 'name', 'blocks'],
};
const date = { type: 'string', description: 'ISO date, YYYY-MM-DD' };

const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: 'get_sessions', description: 'List planned and completed sessions between two dates, with ids, status, duration, load and (when detail is true) the full step-by-step structure with targets. Use it for weeks outside the snapshot or to read a workout in full before explaining or editing it.',
    input_schema: { type: 'object', properties: { from: date, to: date, detail: { type: 'boolean' } }, required: ['from', 'to'] } },
  { name: 'get_history', description: 'Completed activities imported from Intervals.icu between two dates: per-activity date, sport, name, duration, distance, load, normalised power, average HR and intensity factor, plus weekly totals. History can go back years; ask for the range you need.',
    input_schema: { type: 'object', properties: { from: date, to: date, sport: { type: 'string', enum: ['swim', 'bike', 'run', 'strength', 'other'] } }, required: ['from', 'to'] } },
  { name: 'get_season', description: 'The full season outline week by week: phase, recovery/test weeks, target hours and load, projected fitness, races.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'move_session', description: 'Move a session to another date and pin it there.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, date }, required: ['id', 'date'] } },
  { name: 'skip_session', description: 'Mark a session as skipped (it stays visible, struck through).',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] } },
  { name: 'replace_workout', description: 'Replace the workout of an existing session with a new structured workout (same date). Use this to make a session easier, harder, shorter, longer or different.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, workout: workoutSchema, reason: { type: 'string', description: 'Why it was changed, shown to the athlete on the session.' } }, required: ['id', 'workout'] } },
  { name: 'add_session', description: 'Add a new structured session on a date.',
    input_schema: { type: 'object', properties: { date, workout: workoutSchema }, required: ['date', 'workout'] } },
  { name: 'delete_session', description: 'Remove a session from the plan entirely.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'set_day_availability', description: 'Set the training time available on one specific date (0 = unavailable), e.g. for travel or illness. Follow with replan if the plan should adapt to it.',
    input_schema: { type: 'object', properties: { date, minutes: { type: 'integer' }, note: { type: 'string' } }, required: ['date', 'minutes'] } },
  { name: 'replan', description: 'Regenerate the plan from current settings. scope "future" rebuilds the weeks after this one; scope "week" also rebuilds the rest of the current week from today. Pinned and completed sessions are always kept.',
    input_schema: { type: 'object', properties: { scope: { type: 'string', enum: ['future', 'week'] } }, required: ['scope'] } },
];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const hm = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
const dayName = (iso: string) => `${DAY_NAMES[dow(iso)]} ${iso}`;
const line = (x: Session) =>
  `${dayName(x.date)} | id ${x.id} | ${x.sport} | ${x.workout.name} | ${hm(x.workout.durationMin)} | ${x.workout.tss} TSS | ${x.role}${x.workout.hard ? ', hard' : ''} | ${x.status}${x.locked ? ', pinned' : ''}${x.actual ? ` | done: ${hm(x.actual.durationMin ?? 0)}, ${x.actual.tss ?? 0} TSS` : ''}`;

/** The per-turn snapshot of the athlete's situation, prepended to their message. */
export function coachContext(s: State, today: string): string {
  const p = s.profile;
  const z = zoneTable(p);
  const out: string[] = [`Today: ${dayName(today)}`];
  const age = p.birthYear ? +today.slice(0, 4) - p.birthYear : undefined;
  out.push(`Athlete: ${[p.name, age && `${age} y`, p.sex, p.weightKg && `${p.weightKg} kg`].filter(Boolean).join(', ') || 'no details set'}`);
  out.push(`Thresholds: bike FTP ${p.ftp ?? '?'} W, run threshold power ${p.runPower ?? '?'} W, run threshold pace ${p.runPaceSecPerKm ? `${hm(p.runPaceSecPerKm)}/km` : '?'}, swim CSS ${p.cssSecPer100 ? `${hm(p.cssSecPer100)}/100m` : '?'}, bike LTHR ${p.bikeLthr ?? '?'}, run LTHR ${p.runLthr ?? '?'}. Targets: bike by ${p.bikeTarget}, run by ${p.runTarget}.`);
  out.push(`Zones — bike: ${z.bike.map((x) => `${x.id} ${x.target}`).join('; ')} | run: ${z.run.map((x) => `${x.id} ${x.target}`).join('; ')} | swim: ${z.swim.map((x) => `${x.id} ${x.target}`).join('; ')}`);
  out.push(`Settings: max ${p.maxWeeklyHours} h/week, progression ${p.ramp}, recovery cycle ${p.recoveryCycle}, limiter ${p.limiter}, strength ${p.strengthEquipment}.`);
  if (p.comeback.active) out.push(`Return to training: ${p.comeback.weeksOff} weeks off${p.comeback.resumedOn ? `, resumed ${p.comeback.resumedOn}` : ''}${p.comeback.note ? `. Athlete's note: ${p.comeback.note}` : ''}`);
  out.push(`Weekly availability (min): ${s.availability.days.map((d, i) => `${DAY_NAMES[i]} ${d.minutes}${d.pool ? ' pool' : ''}${d.gym ? ' gym' : ''}`).join(', ')}`);
  const ov = Object.entries(s.availability.overrides).filter(([d]) => d >= today).slice(0, 12);
  if (ov.length) out.push(`Date exceptions: ${ov.map(([d, v]) => `${d} ${v.minutes} min${v.note ? ` (${v.note})` : ''}`).join(', ')}`);

  const races = s.races.filter((r) => r.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  out.push(races.length ? `Races: ${races.map((r) => `${r.date} ${r.name} (${r.type}, priority ${r.priority}, in ${diffDays(r.date, today)} days${r.goal ? `, goal: ${r.goal}` : ''})`).join('; ')}` : 'Races: none entered.');
  const goals = s.goals.filter((g) => g.status === 'active');
  if (goals.length) out.push(`Goals: ${goals.map((g) => `${g.title} [${g.category}, ${g.horizon}${g.target ? `, ${g.target}` : ''}${g.due ? `, by ${g.due}` : ''}]`).join('; ')}`);

  if (s.season) {
    out.push('Season (next 8 weeks; get_season for the rest):');
    for (const w of s.season.weeks.slice(0, 8)) out.push(`  ${w.start} ${w.phase}${w.recovery ? ' recovery' : ''}${w.testWeek ? ' +tests' : ''} — ${w.targetHours} h, ${w.targetTss} TSS, projected CTL ${w.ctlEnd}${w.races.length ? ` — ${w.races.map((r) => `${r.priority}-race ${r.name}`).join(', ')}` : ''}`);
    out.push(`Current week focus: ${s.season.weeks[0]?.focus ?? ''}`);
  } else out.push('No plan has been generated yet.');

  const from = mondayOf(today), to = addDays(from, 13);
  const sess = s.sessions.filter((x) => x.date >= from && x.date <= to);
  if (sess.length) { out.push(`Sessions ${from} to ${to}:`); for (const x of sess) out.push(`  ${line(x)}`); }

  const ctl = currentCtl(s);
  const lastW = s.wellness.at(-1);
  if (ctl != null) out.push(`Fitness: CTL ${ctl.toFixed(0)}${lastW?.atl != null ? `, ATL ${lastW.atl.toFixed(0)}, form ${(ctl - lastW.atl).toFixed(0)}` : ''}.`);
  const r = assessReadiness(today, s.wellness, s.checkins[today]);
  out.push(`Readiness today: ${r.status}${r.score != null ? ` (${r.score}/100)` : ''}${r.signals.length ? ` — ${r.signals.map((x) => `${x.label}: ${x.value} [${x.status}]`).join('; ')}` : ''}`);

  const h = summarizeHistory(s.activities, s.wellness, today);
  if (h) {
    out.push(`Training history: ${h.count} activities since ${h.from}. Average ${h.avg4wkHours} h/week over the last 4 full weeks, ${h.avg12wkHours} over 12.${h.best6wk ? ` Best 6-week block ${h.best6wk.hours} h/week (ending ${h.best6wk.end}).` : ''}${h.peakCtl ? ` Peak CTL ${h.peakCtl.value} on ${h.peakCtl.date}.` : ''}`);
    out.push(`Last 8 weeks (h swim/bike/run/strength, TSS): ${h.weeks.slice(-8).map((w) => `${w.start} ${(w.min.swim / 60).toFixed(1)}/${(w.min.bike / 60).toFixed(1)}/${(w.min.run / 60).toFixed(1)}/${(w.min.strength / 60).toFixed(1)} ${w.tss}`).join('; ')}`);
    const recent = s.activities.filter((a) => a.date >= addDays(today, -10));
    if (recent.length) out.push(`Last 10 days: ${recent.map((a) => `${a.date} ${a.sport} "${a.name}" ${hm(a.durationMin)}${a.distanceKm ? ` ${a.distanceKm} km` : ''} ${a.tss} TSS${a.np ? ` NP ${Math.round(a.np)} W` : ''}${a.avgHr ? ` HR ${Math.round(a.avgHr)}` : ''}`).join('; ')}`);
  } else out.push('Training history: nothing imported from Intervals.icu yet.');
  return out.join('\n');
}

/** Run one tool call against the state. Returns the text result; records user-visible changes. */
export function runTool(s: State, today: string, name: string, input: any, changes: string[]): string {
  const find = (id: unknown) => {
    const x = s.sessions.find((q) => q.id === id);
    if (!x) throw new Error(`No session with id "${id}". Use get_sessions to look up ids.`);
    return x;
  };
  const need = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) throw new Error(`${what} must be an ISO date (YYYY-MM-DD).`);
    return v;
  };
  const sort = () => s.sessions.sort((a, b) => a.date.localeCompare(b.date));
  switch (name) {
    case 'get_sessions': {
      const from = need(input.from, 'from'), to = need(input.to, 'to');
      const list = s.sessions.filter((x) => x.date >= from && x.date <= to);
      if (!list.length) return 'No sessions in that range (detailed sessions exist for the current week and the next three; later weeks only have season targets).';
      return list.map((x) => (input.detail ? `${line(x)}\n${toIcuText(finalize(x.workout, s.profile), s.profile)}\n` : line(x))).join('\n');
    }
    case 'get_history': {
      const from = need(input.from, 'from'), to = need(input.to, 'to');
      const list = s.activities.filter((a) => a.date >= from && a.date <= to && (!input.sport || a.sport === input.sport));
      if (!list.length) return 'No imported activities in that range.';
      const weeks = new Map<string, { min: number; tss: number; n: number }>();
      for (const a of list) {
        const w = weeks.get(mondayOf(a.date)) ?? { min: 0, tss: 0, n: 0 };
        w.min += a.durationMin; w.tss += a.tss; w.n++;
        weeks.set(mondayOf(a.date), w);
      }
      const head = `Weekly totals:\n${[...weeks].map(([w, v]) => `${w}: ${hm(v.min)} h, ${v.tss} TSS, ${v.n} sessions`).join('\n')}`;
      // Per-activity rows are capped so a multi-year query stays readable; totals above always cover the full range.
      const rows = list.slice(-150).map((a) => `${a.date} ${a.sport}${a.type ? ` (${a.type})` : ''} "${a.name}" ${hm(a.durationMin)}${a.distanceKm ? ` ${a.distanceKm} km` : ''} ${a.tss} TSS${a.np ? ` NP ${Math.round(a.np)} W` : ''}${a.avgHr ? ` HR ${Math.round(a.avgHr)}` : ''}${a.intensity ? ` IF ${a.intensity}` : ''}`);
      return `${head}\n\nActivities${list.length > 150 ? ` (latest 150 of ${list.length}; narrow the range for the rest)` : ''}:\n${rows.join('\n')}`;
    }
    case 'get_season':
      if (!s.season) return 'No plan generated yet.';
      return s.season.weeks.map((w) => `${w.start} ${w.phase}${w.recovery ? ' recovery' : ''}${w.testWeek ? ' +tests' : ''} ${w.targetHours} h ${w.targetTss} TSS CTL ${w.ctlEnd}${w.races.length ? ` ${w.races.map((r) => `${r.priority}-race ${r.name}`).join(', ')}` : ''}`).join('\n')
        + (s.season.warnings.length ? `\nWarnings: ${s.season.warnings.join(' ')}` : '');
    case 'move_session': {
      const x = find(input.id), to = need(input.date, 'date');
      const was = x.date;
      x.date = to; x.locked = true; sort();
      changes.push(`Moved “${x.workout.name}” from ${dayName(was)} to ${dayName(to)}.`);
      return `Moved. Sessions on ${to} now: ${s.sessions.filter((q) => q.date === to).map((q) => q.workout.name).join(', ')}`;
    }
    case 'skip_session': {
      const x = find(input.id);
      x.status = 'skipped'; x.locked = true; x.origin = 'adapted';
      x.adaptedNote = `Skipped by coach${input.reason ? `: ${String(input.reason).slice(0, 200)}` : '.'}`;
      changes.push(`Skipped “${x.workout.name}” on ${dayName(x.date)}.`);
      return 'Skipped.';
    }
    case 'replace_workout': {
      const x = find(input.id);
      if (x.sport === 'race') throw new Error('Race entries cannot be replaced; edit races in the Races view.');
      const w = customWorkout(input.workout, s.profile);
      const before = x.workout.name;
      x.workout = w; x.sport = w.sport; x.role = w.hard ? 'key' : x.role === 'long' ? 'long' : 'easy';
      x.locked = true; x.origin = 'adapted';
      x.adaptedNote = `Changed by coach (was “${before}”)${input.reason ? `: ${String(input.reason).slice(0, 200)}` : '.'}`;
      changes.push(`Replaced “${before}” on ${dayName(x.date)} with “${w.name}” (${hm(w.durationMin)}, ${w.tss} TSS).`);
      return `Replaced. New workout: ${w.name}, ${w.durationMin} min, ${w.tss} TSS.\n${toIcuText(w, s.profile)}`;
    }
    case 'add_session': {
      const d = need(input.date, 'date');
      const w = customWorkout(input.workout, s.profile);
      const x: Session = { id: uid('s'), date: d, sport: w.sport, role: w.hard ? 'key' : 'easy', workout: w, status: 'planned', locked: true, origin: 'custom' };
      s.sessions.push(x); sort();
      changes.push(`Added “${w.name}” on ${dayName(d)} (${hm(w.durationMin)}, ${w.tss} TSS).`);
      return `Added with id ${x.id}: ${w.durationMin} min, ${w.tss} TSS.`;
    }
    case 'delete_session': {
      const x = find(input.id);
      s.sessions = s.sessions.filter((q) => q !== x);
      changes.push(`Deleted “${x.workout.name}” on ${dayName(x.date)}.`);
      return 'Deleted.';
    }
    case 'set_day_availability': {
      const d = need(input.date, 'date');
      const minutes = Math.max(0, Math.min(600, Math.round(Number(input.minutes) || 0)));
      s.availability.overrides[d] = { minutes, note: input.note ? String(input.note).slice(0, 80) : undefined };
      changes.push(`Set availability on ${dayName(d)} to ${minutes} min.`);
      return 'Availability set. Existing sessions on that day were not changed; call replan (scope "week" if the date is in the current week) to rebuild around it.';
    }
    case 'replan': {
      const scope = input.scope === 'week' ? 'week' : 'future';
      generate(s, today, scope);
      changes.push(scope === 'week' ? 'Rebuilt the rest of this week and the following weeks.' : 'Re-planned the following weeks.');
      const to = addDays(mondayOf(today), 13);
      return `Re-planned. Sessions through ${to}:\n${s.sessions.filter((x) => x.date >= today && x.date <= to).map(line).join('\n')}`;
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

let sdk: typeof import('@anthropic-ai/sdk') | undefined;
async function client(apiKey?: string): Promise<Anthropic> {
  try { sdk ??= await import('@anthropic-ai/sdk'); } catch { throw new CoachError(500, 'The Claude SDK is not installed. Run `npm install` in the project folder and restart.'); }
  // Without a stored key the SDK resolves credentials from the environment (ANTHROPIC_API_KEY etc.).
  return apiKey ? new sdk.default({ apiKey }) : new sdk.default();
}

export const coachConfigured = (s: State) => !!(s.coach.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** The conversation as the UI shows it: athlete and coach text only, without context blocks or tool traffic. */
export function chatView(s: State) {
  const out: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const m of s.coach.messages as Anthropic.Beta.BetaMessageParam[]) {
    if (typeof m.content === 'string') { out.push({ role: m.role as 'user' | 'assistant', text: m.content }); continue; }
    const text = (m.content ?? []).flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .filter((t) => !t.startsWith('<context>')).join('\n').trim();
    if (!text) continue;
    const last = out.at(-1);
    if (m.role === 'assistant' && last?.role === 'assistant') last.text += `\n\n${text}`;
    else out.push({ role: m.role as 'user' | 'assistant', text });
  }
  return out;
}

/** Send one athlete message, let Claude use tools until it is done, and return its reply. */
export async function coachTurn(s: State, today: string, message: string): Promise<{ reply: string; changes: string[] }> {
  if (!coachConfigured(s)) throw new CoachError(400, 'Add your Anthropic API key under Connect to use the coach.');
  const anthropic = await client(s.coach.apiKey);
  const { APIError, AuthenticationError, RateLimitError, APIConnectionError, PermissionDeniedError } = sdk!;
  const messages = s.coach.messages as Anthropic.Beta.BetaMessageParam[];
  const start = messages.length;
  messages.push({ role: 'user', content: [{ type: 'text', text: `<context>\n${coachContext(s, today)}\n</context>` }, { type: 'text', text: message }] });
  const changes: string[] = [];
  const texts: string[] = [];
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await anthropic.beta.messages.create({
        model: COACH_MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools: TOOLS,
        messages,
        // Cache the growing conversation prefix; the system prompt and tools never change.
        cache_control: { type: 'ephemeral' },
        output_config: { effort: 'medium' },
        // If a safety classifier declines a request, let the API retry it on a fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      // Preserve every block (thinking included) so the next request replays the history unchanged.
      messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
      for (const b of res.content) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
      if (res.stop_reason === 'refusal') { texts.push('I can’t help with that request.'); break; }
      if (res.stop_reason === 'max_tokens') { texts.push('(The answer was cut off for length — ask me to continue.)'); break; }
      if (res.stop_reason === 'pause_turn') continue;
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !calls.length) break;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = calls.map((c) => {
        try { return { type: 'tool_result', tool_use_id: c.id, content: runTool(s, today, c.name, c.input ?? {}, changes) }; }
        catch (e: any) { return { type: 'tool_result', tool_use_id: c.id, content: String(e?.message ?? e), is_error: true }; }
      });
      messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    // Drop the failed exchange unless a tool already changed the plan, so the history stays a valid, replayable transcript.
    if (!changes.length) messages.length = start;
    else if (messages.at(-1)?.role === 'user') messages.push({ role: 'assistant', content: [{ type: 'text', text: '(Connection to Claude was lost before I could finish.)' }] });
    if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) throw new CoachError(502, 'Claude rejected the API key. Check it under Connect.');
    if (e instanceof RateLimitError) throw new CoachError(502, 'Claude is rate-limiting this key. Wait a moment and try again.');
    if (e instanceof APIConnectionError) throw new CoachError(502, 'Could not reach the Claude API. Check the network connection.');
    if (e instanceof APIError) throw new CoachError(502, `Claude API error${e.status ? ` ${e.status}` : ''}: ${e.message}`);
    throw e;
  }
  // The loop can end on a tool result if it hits MAX_TURNS; close the transcript so the next message is valid.
  if (messages.at(-1)?.role === 'user') messages.push({ role: 'assistant', content: [{ type: 'text', text: '(Stopped after several steps — tell me if you want me to continue.)' }] });
  return { reply: texts.join('\n\n') || (changes.length ? 'Done.' : '(No reply.)'), changes };
}
