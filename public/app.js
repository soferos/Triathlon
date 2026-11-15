// Single-page UI. No framework: a tiny hyperscript helper and full re-render on state change.
const $ = (s) => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toDate = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
const addDays = (iso, n) => new Date(toDate(iso).getTime() + n * 864e5).toISOString().slice(0, 10);
const dow = (iso) => (toDate(iso).getUTCDay() + 6) % 7;
const fmtDate = (iso, long) => `${DAYS[dow(iso)]} ${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}${long ? ` ${iso.slice(0, 4)}` : ''}`;
const hm = (min) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
const clock = (secs) => (secs ? `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}` : '');
const parseClock = (t) => {
  if (!t) return null;
  const m = String(t).trim().match(/^(\d+):(\d{1,2})$/);
  if (m) return +m[1] * 60 + +m[2];
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const SPORT = { swim: 'Swim', bike: 'Bike', run: 'Run', strength: 'Strength', race: 'Race' };
const PHASE = { rebuild: 'Rebuild', base: 'Base', build: 'Build', specific: 'Specific', taper: 'Taper', race: 'Race', transition: 'Transition' };
const PHASE_VAR = { rebuild: '--rebuild', base: '--base', build: '--build', specific: '--specific', taper: '--taper', race: '--racep', transition: '--transition' };
const RACE_TYPES = { sprint: 'Sprint triathlon', olympic: 'Olympic triathlon', half: '70.3 / half', full: 'Ironman / full', run10k: '10 km run', halfMarathon: 'Half marathon', marathon: 'Marathon', bikeEvent: 'Bike event / TT', other: 'Other' };

let S = null;
let view = location.hash.slice(1) || 'today';
let planWeek = 0;
const draft = {}; // unsaved form state per view

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = bad ? 'bad' : ''; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), bad ? 6000 : 3200);
}
async function load() { S = await api('GET', '/api/state'); render(); }
// Pull new activities from Intervals.icu without being asked: on open and when the tab regains focus, at most every 10 minutes.
let syncing = false;
async function autoSync() {
  if (!S?.intervals.connected || syncing || document.hidden) return;
  if (S.intervals.lastSync && Date.now() - new Date(S.intervals.lastSync).getTime() < 10 * 60 * 1000) return;
  syncing = true;
  try {
    const r = await api('POST', '/api/intervals/sync', {});
    await load();
    if (r.matched) toast(`${r.matched} completed ${r.matched === 1 ? 'activity' : 'activities'} matched to your plan`);
  } catch { await load().catch(() => {}); }
  syncing = false;
}
document.addEventListener('visibilitychange', autoSync);
async function act(fn, ok) {
  try { const r = await fn(); await load(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); return r; }
  catch (e) { toast(e.message, true); }
}
// Saving inputs that shape the plan regenerates future weeks (the current week is left alone).
const saveAndReplan = (method, path, body, msg) => act(async () => {
  await api(method, path, body);
  if (S.season) await api('POST', '/api/plan/generate', {});
}, S.season ? `${msg} Future weeks re-planned.` : msg);

const VIEWS = [
  ['today', 'Today'], ['plan', 'Plan'], ['coach', 'Coach'], ['season', 'Season'], ['history', 'History'], ['races', 'Races & goals'], ['availability', 'Availability'],
  ['workouts', 'Workouts'], ['strength', 'Strength'], ['profile', 'Profile & zones'], ['connect', 'Connect'], ['method', 'Method'],
];
function go(v) { view = v; location.hash = v; render(); window.scrollTo(0, 0); }
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v && v !== view) { view = v; render(); } });

function render() {
  $('#nav').replaceChildren(h('div', { class: 'brand' }, 'Triathlon Coach'),
    ...VIEWS.map(([id, label]) => h('button', { class: id === view ? 'on' : '', onclick: () => go(id) }, label)));
  const fn = { coach: vCoach, history: vHistory, today: vToday, plan: vPlan, season: vSeason, races: vRaces, availability: vAvailability, workouts: vWorkouts, strength: vStrength, profile: vProfile, connect: vConnect, method: vMethod }[view] || vToday;
  $('#main').replaceChildren(...[fn()].flat());
}
const page = (title, sub, ...actions) => h('header', { class: 'page' }, h('div', {}, h('h1', {}, title), sub && h('div', { class: 'sub' }, sub)), h('div', { class: 'row right' }, actions));
const card = (title, ...kids) => h('div', { class: 'card' }, title && h('h2', {}, title), kids);
const field = (label, input) => h('label', { class: 'f' }, label, input);
const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, onclick }, label);

// ---------------- workout rendering ----------------
function profileBar(w) {
  const steps = [];
  for (const b of w.view) for (let i = 0; i < b.repeat; i++) for (const s of b.steps) steps.push(s);
  const total = steps.reduce((t, s) => t + s.secs, 0);
  if (!total) return null;
  const max = Math.max(1.2, ...steps.map((s) => s.hi));
  return h('div', { class: `profilebar ${w.sport}` }, steps.map((s) => h('i', { style: `width:${(s.secs / total) * 100}%;height:${Math.max(4, (((s.lo + s.hi) / 2) / max) * 100)}%`, title: `${s.dur} · ${s.target}` })));
}
function workoutDetail(w) {
  return h('div', {},
    h('p', {}, w.description),
    w.notes && h('p', { class: 'muted small' }, w.notes),
    profileBar(w),
    w.view.length ? h('div', { class: 'steps' }, w.view.map((b) => [
      h('div', { class: 'b' }, b.repeat > 1 ? `${b.repeat} × ${b.name}` : b.name),
      b.steps.map((s) => h('div', { class: 's' }, h('span', { class: 'num' }, s.dur), h('span', {}, s.cue || { warmup: 'Warm-up', work: 'Steady', recovery: 'Recovery', cooldown: 'Cool-down', rest: 'Rest' }[s.kind], s.cadence ? h('span', { class: 'muted' }, ` · ${s.cadence} rpm`) : null), h('span', { class: 'tg' }, s.target))),
    ])) : null,
    w.exercises?.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Exercise'), h('th', {}, 'Sets × reps'), h('th', {}, 'Load'))),
      h('tbody', {}, w.exercises.map((e) => h('tr', {}, h('td', {}, e.name, e.note && h('div', { class: 'muted small' }, e.note)), h('td', {}, e.sets), h('td', {}, e.load)))))) : null,
  );
}
const meta = (w) => `${hm(w.durationMin)} · ${w.tss} TSS`;
function sessCard(x) {
  const missed = x.status === 'planned' && x.date < S.today;
  const a = x.actual;
  return h('div', { class: `sess ${x.sport} ${x.status} ${missed ? 'missed' : ''}`, onclick: () => sessionDialog(x) },
    h('div', { class: 't' }, x.workout.name),
    a ? [h('div', { class: 'm did' }, `Did: ${actualLine(a)}`), h('div', { class: 'm' }, `Planned ${meta(x.workout)}${verdict(x) ? ` · ${verdict(x)}` : ''}`)]
      : h('div', { class: 'm' }, `${SPORT[x.sport]} · ${meta(x.workout)}${x.origin === 'adapted' ? ' · adapted' : x.origin === 'custom' ? ' · custom' : ''}${missed ? ' · not done' : ''}`));
}
const actualLine = (a) => [hm(a.durationMin || 0), a.distanceKm && `${a.distanceKm} km`, `${a.tss ?? 0} TSS`, a.np && `NP ${Math.round(a.np)} W`, a.avgHr && `${Math.round(a.avgHr)} bpm`].filter(Boolean).join(' · ');
// How the completed session compares with the plan, by duration.
function verdict(x) {
  const r = (x.actual?.durationMin || 0) / Math.max(1, x.workout.durationMin);
  const moved = x.actual?.plannedDate ? `moved from ${fmtDate(x.actual.plannedDate)}` : '';
  const size = r > 1.2 ? `${Math.round((r - 1) * 100)}% longer` : r < 0.8 ? `${Math.round((1 - r) * 100)}% shorter` : '';
  return [size, moved].filter(Boolean).join(', ');
}
const extraCard = (a) => h('div', { class: `sess extra ${a.sport}`, onclick: () => extraDialog(a) },
  h('div', { class: 't' }, a.name), h('div', { class: 'm did' }, `Did: ${actualLine(a)}`), h('div', { class: 'm' }, `${a.type || SPORT[a.sport] || 'Activity'} · not in plan`));
function extraDialog(a) {
  openDialog(a.sport, a.name, [
    h('div', { class: 'row', style: 'margin-bottom:10px' }, h('span', { class: 'pill' }, fmtDate(a.date, true)), h('span', { class: 'pill good' }, 'Completed'), h('span', { class: 'pill' }, a.type || a.sport)),
    h('p', {}, actualLine(a), a.intensity ? ` · IF ${a.intensity}` : ''),
    h('p', { class: 'muted small' }, 'This activity was recorded in Intervals.icu but no planned session of this sport was close enough to match it (same week, within two days, broadly similar length). Its load still counts in your week and your fitness.'),
  ]);
}
function openDialog(cls, title, body) {
  const d = $('#dlg');
  d.replaceChildren(h('div', { class: `dh ${cls}` }, h('h2', { style: 'margin:0' }, title), h('button', { class: 'btn sm right', onclick: () => d.close() }, 'Close')), h('div', { class: 'db' }, body));
  if (!d.open) d.showModal();
}
function sessionDialog(x) {
  const close = () => $('#dlg').close();
  const patch = (body, msg) => act(() => api('PATCH', `/api/sessions/${x.id}`, body), msg).then(close);
  const date = h('input', { type: 'date', value: x.date });
  openDialog(x.sport, x.workout.name, [
    h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('span', { class: 'pill' }, fmtDate(x.date, true)), h('span', { class: 'pill' }, meta(x.workout)),
      x.workout.hard && h('span', { class: 'pill warn' }, 'Key intensity'), x.locked && h('span', { class: 'pill' }, 'Pinned'),
      x.status !== 'planned' && h('span', { class: `pill ${x.status === 'done' ? 'good' : ''}` }, x.status)),
    x.adaptedNote && h('div', { class: 'notice info' }, x.adaptedNote),
    x.actual && h('div', { class: 'notice good' },
      h('div', {}, h('b', {}, `Completed: ${x.actual.name || 'activity'}`), x.actual.plannedDate ? ` — done on ${fmtDate(x.date)}, planned for ${fmtDate(x.actual.plannedDate)}` : ''),
      h('table', { style: 'margin-top:6px' }, h('thead', {}, h('tr', {}, ['', 'Time', 'Load', 'Distance', 'NP', 'Avg HR', 'IF'].map((c) => h('th', {}, c)))), h('tbody', {},
        h('tr', {}, h('td', {}, h('b', {}, 'Did')), h('td', { class: 'num' }, hm(x.actual.durationMin || 0)), h('td', { class: 'num' }, `${x.actual.tss ?? 0} TSS`), h('td', { class: 'num' }, x.actual.distanceKm ? `${x.actual.distanceKm} km` : '–'),
          h('td', { class: 'num' }, x.actual.np ? `${Math.round(x.actual.np)} W` : '–'), h('td', { class: 'num' }, x.actual.avgHr ? Math.round(x.actual.avgHr) : '–'), h('td', { class: 'num' }, x.actual.intensity ?? '–')),
        h('tr', {}, h('td', {}, 'Planned'), h('td', { class: 'num' }, hm(x.workout.durationMin)), h('td', { class: 'num' }, `${x.workout.tss} TSS`), h('td', {}, ''), h('td', {}, ''), h('td', {}, ''), h('td', {}, '')))),
      verdict(x) && h('div', { class: 'small', style: 'margin-top:6px' }, `Versus plan: ${verdict(x)}.`)),
    x.actual && h('h3', {}, 'What was planned'),
    workoutDetail(x.workout),
    x.sport !== 'race' && x.sport !== 'strength' && h('details', {}, h('summary', { class: 'muted small' }, 'Intervals.icu workout text'), h('pre', { class: 'icu' }, x.workout.icu)),
    h('div', { class: 'row', style: 'margin-top:14px' },
      x.status !== 'done' && btn('Mark done', () => patch({ status: 'done' }, 'Marked done'), 'primary'),
      x.status !== 'skipped' && btn('Skip', () => patch({ status: 'skipped' }, 'Skipped')),
      x.status !== 'planned' && btn('Back to planned', () => patch({ status: 'planned' }, 'Restored')),
      btn(x.locked ? 'Unpin' : 'Pin', () => patch({ locked: !x.locked }, x.locked ? 'Unpinned — may change on re-plan' : 'Pinned — survives re-planning')),
      btn('Delete', () => act(() => api('DELETE', `/api/sessions/${x.id}`), 'Deleted').then(close), 'danger'),
      x.sport !== 'race' && btn('Ask the coach', () => { close(); askCoach(`What is the purpose of “${x.workout.name}” on ${fmtDate(x.date)}, why is it placed there, and how should I execute it?`); })),
    h('div', { class: 'row', style: 'margin-top:10px' }, field('Move to', date), btn('Move', () => patch({ date: date.value }, 'Moved and pinned'))),
  ]);
}

// ---------------- Today ----------------
function vToday() {
  const t = S.today;
  const todays = S.sessions.filter((x) => x.date === t);
  const wk = S.season?.weeks[0];
  const out = [page(`Today · ${fmtDate(t, true)}`, wk ? `${PHASE[wk.phase]} phase${wk.recovery ? ' · recovery week' : ''} — ${wk.focus}` : 'No plan yet')];
  if (!S.season) {
    out.push(card('Get started',
      h('ol', { class: 'clean' },
        h('li', {}, h('a', { href: '#connect' }, 'Connect Intervals.icu'), ' to pull your thresholds, fitness and HRV (optional but recommended).'),
        h('li', {}, 'Check your ', h('a', { href: '#profile' }, 'profile & thresholds'), ' — including how long you were off.'),
        h('li', {}, 'Set your weekly ', h('a', { href: '#availability' }, 'availability'), ' and add your ', h('a', { href: '#races' }, 'races'), '.'),
        h('li', {}, 'Generate the plan.')),
      h('div', { style: 'margin-top:12px' }, btn('Generate my plan', () => act(() => api('POST', '/api/plan/generate', {}), 'Plan generated'), 'primary'))));
  }
  if (S.needs.length) out.push(h('div', { class: 'notice' }, `Missing thresholds: ${S.needs.join(', ')}. Targets show as % until set — `, h('a', { href: '#profile' }, 'add them'), ' or sync from Intervals.icu.'));
  if (S.intervals.lastError) out.push(h('div', { class: 'notice bad' }, `Intervals.icu: ${S.intervals.lastError}`));

  const r = S.readiness;
  const cls = { go: 'good', adjust: 'warn', recover: 'bad', unknown: '' }[r.status];
  const ci = draft.checkin ??= { ...(S.checkin || {}) };
  const sel = (key, label) => field(label, h('select', { onchange: (e) => (ci[key] = +e.target.value || undefined) },
    [['', '—'], [1, '1 · great'], [2, '2'], [3, '3 · normal'], [4, '4'], [5, '5 · awful']].map(([v, l]) => h('option', { value: v, selected: ci[key] == v }, l))));
  const readiness = card('Readiness',
    h('div', { class: 'row' }, h('span', { class: `pill ${cls}` }, r.headline), r.score != null && h('span', { class: 'stat' }, r.score), r.score != null && h('span', { class: 'muted' }, '/ 100')),
    h('p', { style: 'margin-top:8px' }, r.advice),
    r.signals.map((s) => h('div', { class: 'signal' }, h('span', { class: `pill ${s.status === 'good' ? 'good' : s.status === 'ok' ? '' : s.status}` }, s.label), h('div', {}, h('div', { class: 'num' }, s.value), h('div', { class: 'muted small' }, s.detail)))),
    (r.status === 'adjust' || r.status === 'recover') && todays.some((x) => x.status === 'planned') && h('div', { style: 'margin-top:10px' },
      btn('Adapt today’s training', () => act(() => api('POST', '/api/readiness/apply', {}), (res) => res.changes.length ? res.changes.join(' ') : 'Nothing needed changing.'), 'primary')),
    h('details', { style: 'margin-top:12px', open: !S.intervals.connected }, h('summary', {}, 'Daily check-in'),
      h('div', { class: 'form', style: 'margin-top:10px' }, sel('fatigue', 'Fatigue'), sel('soreness', 'Soreness'), sel('stress', 'Life stress'),
        field('Sleep (h)', h('input', { type: 'number', step: '0.25', min: 0, max: 14, value: ci.sleepHours ?? '', oninput: (e) => (ci.sleepHours = +e.target.value || undefined) })),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!ci.symptoms, onchange: (e) => (ci.symptoms = e.target.checked) }), 'Illness symptoms')),
      h('div', { style: 'margin-top:10px' }, btn('Save check-in', () => act(() => api('POST', '/api/checkin', ci), 'Check-in saved').then(() => delete draft.checkin)))));

  const sessions = card('Today’s training',
    todays.length ? todays.map((x) => h('div', { class: x.sport, style: 'border-left:4px solid var(--c);padding-left:12px;margin-bottom:16px' },
      h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, x.workout.name), h('span', { class: 'pill' }, meta(x.workout)), x.status !== 'planned' && h('span', { class: `pill ${x.status === 'done' ? 'good' : ''}` }, x.status),
        h('button', { class: 'btn sm right', onclick: () => sessionDialog(x) }, 'Options')),
      x.adaptedNote && h('div', { class: 'muted small' }, x.adaptedNote),
      x.actual && h('div', { class: 'notice good', style: 'margin-top:6px' }, h('b', {}, 'Did: '), `${x.actual.name || 'activity'} — ${actualLine(x.actual)}${verdict(x) ? ` (${verdict(x)})` : ''}`),
      workoutDetail(x.workout)))
      : !S.extras.some((a) => a.date === t) && h('p', { class: 'muted' }, S.season ? 'Rest day. Sleep, eat, and leave it alone — this is where the adaptation happens.' : 'Nothing planned.'),
    S.extras.filter((a) => a.date === t).map(extraCard));

  const ws = S.weekStats[0];
  const side = [readiness];
  if (ws) side.push(card('This week',
    h('div', { class: 'grid g2' },
      h('div', {}, h('div', { class: 'label' }, 'Load'), h('div', { class: 'stat num' }, `${ws.doneTss} / ${ws.plannedTss}`), h('div', { class: 'muted small' }, 'TSS done / planned')),
      h('div', {}, h('div', { class: 'label' }, 'Time'), h('div', { class: 'stat num' }, `${hm(ws.doneMin)} / ${hm(ws.plannedMin)}`), h('div', { class: 'muted small' }, `Key sessions ${ws.keyDone}/${ws.keyTotal}`))),
    S.ctl != null && h('p', { class: 'muted small', style: 'margin-top:10px' }, `Fitness (CTL) ${S.ctl.toFixed(0)}${S.monotony ? ` · monotony ${S.monotony.monotony}${S.monotony.monotony > 2 ? ' (high: vary your days more)' : ''}` : ''}`)));
  if (S.nextRace) side.push(card('Next race', h('div', { class: 'stat' }, `${S.nextRace.days} days`), h('div', {}, `${S.nextRace.name} · ${RACE_TYPES[S.nextRace.type]} · priority ${S.nextRace.priority}`), h('div', { class: 'muted small' }, fmtDate(S.nextRace.date, true))));
  out.push(h('div', { class: 'grid g2' }, h('div', {}, sessions), h('div', {}, side)));
  return out;
}

// ---------------- Plan ----------------
function vPlan() {
  if (!S.season) return [page('Plan'), card(null, h('p', {}, 'No plan yet.'), btn('Generate my plan', () => act(() => api('POST', '/api/plan/generate', {}), 'Plan generated'), 'primary'))];
  const weeks = S.season.weeks.slice(0, S.weekStats.length);
  planWeek = Math.min(planWeek, weeks.length - 1);
  const wk = weeks[planWeek], ws = S.weekStats[planWeek];
  const pushDays = h('select', {}, [7, 14, 21, 28].map((d) => h('option', { value: d, selected: d === 14 }, `${d} days`)));
  const out = [page('Training plan', `${PHASE[wk.phase]}${wk.recovery ? ' · recovery week' : ''}${wk.testWeek ? ' · testing' : ''} — target ${wk.targetHours} h / ${wk.targetTss} TSS`,
    btn('Add workout', () => addDialog(wk.start)),
    btn('Re-plan', () => act(() => api('POST', '/api/plan/generate', {}), 'Future weeks re-planned')),
    btn('Rebuild this week', () => confirm('Rebuild the rest of the current week from today? Pinned and completed sessions are kept.') && act(() => api('POST', '/api/plan/generate', { scope: 'week' }), 'Week rebuilt')),
    S.intervals.connected && h('span', { class: 'row' }, pushDays, btn('Push to Intervals.icu', () => act(() => api('POST', '/api/intervals/push', { days: +pushDays.value }), (r) => `Pushed ${r.pushed} workouts${r.removed ? `, removed ${r.removed} stale` : ''}`), 'primary')))];
  out.push(h('div', { class: 'row', style: 'margin-bottom:12px' }, weeks.map((w, i) => h('button', { class: `btn ${i === planWeek ? 'primary' : ''}`, onclick: () => { planWeek = i; render(); } }, i === 0 ? 'This week' : `${+w.start.slice(8)} ${MONTHS[+w.start.slice(5, 7) - 1]}`, ' ', h('span', { class: 'small' }, `· ${PHASE[w.phase]}${w.recovery ? ' (R)' : ''}`)))));
  for (const w of S.weekWarnings[wk.start] || []) out.push(h('div', { class: 'notice' }, w));
  out.push(h('div', { class: 'week' }, DAYS.map((d, i) => {
    const date = addDays(wk.start, i);
    const list = S.sessions.filter((x) => x.date === date);
    const ov = S.availability.overrides[date];
    const cap = ov ? ov.minutes : S.availability.days[i].minutes;
    return h('div', { class: `day ${date === S.today ? 'today' : ''} ${date < S.today ? 'past' : ''}` },
      h('div', { class: 'dh' }, h('b', {}, `${d} ${+date.slice(8)}`), h('span', {}, ov ? `${ov.note || 'override'} · ${hm(cap)}` : hm(cap))),
      list.map(sessCard), S.extras.filter((a) => a.date === date).map(extraCard),
      !list.length && !S.extras.some((a) => a.date === date) && h('div', { class: 'muted small' }, cap < 30 ? 'Unavailable' : 'Rest'));
  })));
  const sports = Object.entries(ws.bySport).sort((a, b) => b[1] - a[1]);
  out.push(h('div', { class: 'grid g3', style: 'margin-top:14px' },
    card('Planned', h('div', { class: 'stat num' }, `${hm(ws.plannedMin)} · ${ws.plannedTss} TSS`), h('div', { class: 'muted small' }, `Target ${wk.targetHours} h · ${wk.targetTss} TSS`)),
    card('Completed', h('div', { class: 'stat num' }, `${hm(ws.doneMin)} · ${ws.doneTss} TSS`), h('div', { class: 'muted small' }, `Key sessions ${ws.keyDone}/${ws.keyTotal}`)),
    card('By discipline', sports.map(([sp, min]) => h('div', { class: `row ${sp}` }, h('span', { class: 'dot', style: 'background:var(--c)' }), h('span', {}, SPORT[sp]), h('span', { class: 'right num' }, hm(min)))))));
  out.push(h('p', { class: 'muted small' }, wk.focus));
  return out;
}
function addDialog(weekStart) {
  const date = h('input', { type: 'date', value: weekStart < S.today ? S.today : weekStart });
  const pick = h('select', {}, S.library.map((l) => h('option', { value: l.id }, `${SPORT[l.workout.sport]} · ${l.workout.name} (${meta(l.workout)})`)));
  openDialog('', 'Add workout', S.library.length ? [
    h('div', { class: 'form' }, field('Date', date), field('Workout from your library', pick)),
    h('div', { style: 'margin-top:14px' }, btn('Add to plan', () => act(() => api('POST', '/api/sessions', { date: date.value, libraryId: pick.value }), 'Added and pinned').then(() => $('#dlg').close()), 'primary')),
  ] : [h('p', {}, 'Your library is empty. Build a workout first.'), btn('Open workout builder', () => { $('#dlg').close(); go('workouts'); }, 'primary')]);
}

// ---------------- Season ----------------
function vSeason() {
  if (!S.season) return [page('Season'), card(null, h('p', {}, 'Generate a plan to see the season.'))];
  const weeks = S.season.weeks;
  const W = 960, H = 250, padL = 36, padB = 26, padT = 22;
  const bw = (W - padL - 8) / weeks.length;
  const maxT = Math.max(...weeks.map((w) => w.targetTss), 100);
  const maxC = Math.max(...weeks.map((w) => w.ctlEnd), 10) * 1.1;
  const y = (v, max) => padT + (H - padT - padB) * (1 - v / max);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:auto', role: 'img', 'aria-label': 'Season load and fitness' });
  for (const t of [0.5, 1]) { const v = Math.round((maxT * t) / 50) * 50; g.append(svg('line', { x1: padL, x2: W, y1: y(v, maxT), y2: y(v, maxT), stroke: 'var(--line)' }), svg('text', { x: 2, y: y(v, maxT) + 4 }, v)); }
  weeks.forEach((w, i) => {
    const x = padL + i * bw;
    const r = svg('rect', { x: x + 1, y: y(w.targetTss, maxT), width: Math.max(1, bw - 2), height: H - padB - y(w.targetTss, maxT), rx: 2, fill: `var(${PHASE_VAR[w.phase]})`, opacity: w.recovery ? 0.45 : 0.9 });
    r.append(svg('title', {}, `${fmtDate(w.start, true)} · ${PHASE[w.phase]}${w.recovery ? ' (recovery)' : ''} · ${w.targetHours} h · ${w.targetTss} TSS · CTL ${w.ctlEnd}`));
    g.append(r);
    if (+w.start.slice(8) <= 7) g.append(svg('text', { x, y: H - 8 }, MONTHS[+w.start.slice(5, 7) - 1]));
    for (const race of w.races) g.append(svg('text', { x: x + bw / 2, y: 12, 'text-anchor': 'middle', style: 'fill:var(--text);font-weight:700' }, `▼${race.priority}`));
  });
  g.append(svg('polyline', { fill: 'none', stroke: 'var(--text)', 'stroke-width': 2, points: weeks.map((w, i) => `${padL + (i + 0.5) * bw},${y(w.ctlEnd, maxC)}`).join(' ') }));
  const peak = weeks.reduce((a, b) => (b.ctlEnd > a.ctlEnd ? b : a));
  return [
    page('Season plan', `${weeks.length} weeks · projected peak fitness (CTL) ${peak.ctlEnd.toFixed(0)} in the week of ${fmtDate(peak.start)}`),
    ...S.season.warnings.map((w) => h('div', { class: 'notice' }, w)),
    card('Weekly load and projected fitness', g,
      h('div', { class: 'legend' }, Object.entries(PHASE).map(([k, v]) => h('span', {}, h('i', { style: `background:var(${PHASE_VAR[k]})` }), v)), h('span', {}, h('i', { style: 'background:var(--text);height:2px' }), 'Fitness (CTL)'), h('span', {}, 'Faded bars = recovery weeks · ▼ = race'))),
    card('Week by week', h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Week of', 'Phase', 'Hours', 'TSS', 'CTL', 'Notes'].map((c) => h('th', {}, c)))),
      h('tbody', {}, weeks.map((w) => h('tr', {},
        h('td', { class: 'num' }, fmtDate(w.start)), h('td', {}, h('span', { class: 'row' }, h('span', { class: 'dot', style: `background:var(${PHASE_VAR[w.phase]})` }), PHASE[w.phase])),
        h('td', { class: 'num' }, w.targetHours), h('td', { class: 'num' }, w.targetTss), h('td', { class: 'num' }, w.ctlEnd.toFixed(0)),
        h('td', { class: 'small' }, [w.recovery && 'Recovery', w.testWeek && 'Threshold tests', ...w.races.map((r) => `${r.priority}-race: ${r.name}`)].filter(Boolean).join(' · ')))))))),
  ];
}

// ---------------- Races & goals ----------------
function vRaces() {
  const races = draft.races ??= structuredClone(S.races).sort((a, b) => a.date.localeCompare(b.date));
  const goals = draft.goals ??= structuredClone(S.goals);
  const inp = (obj, key, attrs = {}) => h('input', { value: obj[key] ?? '', oninput: (e) => (obj[key] = e.target.value), ...attrs });
  const sel = (obj, key, opts) => h('select', { onchange: (e) => (obj[key] = e.target.value) }, Object.entries(opts).map(([v, l]) => h('option', { value: v, selected: obj[key] === v }, l)));
  const del = (list, i) => h('button', { class: 'btn sm danger', onclick: () => { list.splice(i, 1); render(); } }, '✕');
  return [
    page('Races & goals', 'A-races shape the whole season. B-races get a short freshen-up. C-races are trained through.'),
    card('Race calendar',
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Race', 'Date', 'Type', 'Priority', 'Goal', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, races.map((r, i) => h('tr', {}, h('td', {}, inp(r, 'name', { placeholder: 'Race name' })), h('td', {}, inp(r, 'date', { type: 'date' })), h('td', {}, sel(r, 'type', RACE_TYPES)),
          h('td', {}, sel(r, 'priority', { A: 'A', B: 'B', C: 'C' })), h('td', {}, inp(r, 'goal', { placeholder: 'e.g. sub 4:30, AG podium' })), h('td', {}, del(races, i))))))),
      h('div', { class: 'row', style: 'margin-top:10px' },
        btn('Add race', () => { races.push({ name: '', date: addDays(S.today, 120), type: 'half', priority: 'A' }); render(); }),
        btn('Save races', () => saveAndReplan('PUT', '/api/races', races, 'Races saved.').then(() => delete draft.races), 'primary'))),
    card('Goals',
      h('p', { class: 'muted small' }, 'Performance, health, skill and life goals in one place. Season goals should serve the long-term ones — review them at every recovery week.'),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Goal', 'Area', 'Horizon', 'Measure / target', 'By', 'Status', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, goals.map((g, i) => h('tr', {}, h('td', {}, inp(g, 'title', { placeholder: 'e.g. Top-3 age group at 70.3', style: 'min-width:220px' })),
          h('td', {}, sel(g, 'category', { performance: 'Performance', health: 'Health', skill: 'Skill', life: 'Life balance' })), h('td', {}, sel(g, 'horizon', { season: 'This season', 'long-term': 'Long term' })),
          h('td', {}, inp(g, 'target', { placeholder: 'e.g. FTP 4.3 W/kg' })), h('td', {}, inp(g, 'due', { type: 'date' })), h('td', {}, sel(g, 'status', { active: 'Active', achieved: 'Achieved', parked: 'Parked' })), h('td', {}, del(goals, i))))))),
      h('div', { class: 'row', style: 'margin-top:10px' },
        btn('Add goal', () => { goals.push({ title: '', category: 'performance', horizon: 'season', status: 'active' }); render(); }),
        btn('Save goals', () => act(() => api('PUT', '/api/goals', goals), 'Goals saved').then(() => delete draft.goals), 'primary'))),
  ];
}

// ---------------- Availability ----------------
function vAvailability() {
  const a = draft.availability ??= structuredClone(S.availability);
  const ov = draft.overrides ??= Object.entries(a.overrides).map(([date, v]) => ({ date, ...v })).sort((x, y) => x.date.localeCompare(y.date));
  const total = h('b', { class: 'num' });
  const upd = () => (total.textContent = `${hm(a.days.reduce((t, d) => t + (+d.minutes || 0), 0))} h available per week (plan uses up to ${S.profile.maxWeeklyHours} h)`);
  upd();
  const save = () => {
    a.overrides = Object.fromEntries(ov.filter((o) => o.date).map((o) => [o.date, { minutes: +o.minutes || 0, note: o.note }]));
    return saveAndReplan('PUT', '/api/availability', a, 'Availability saved.').then(() => { delete draft.availability; delete draft.overrides; });
  };
  return [
    page('Availability', 'Tell the plan when you can train. It decides what goes where.'),
    card('Typical week',
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Day', 'Time available (min)', 'Pool access', 'Gym access'].map((c) => h('th', {}, c)))),
        h('tbody', {}, a.days.map((d, i) => h('tr', {}, h('td', {}, h('b', {}, DAYS[i])),
          h('td', {}, h('input', { type: 'number', min: 0, max: 600, step: 15, value: d.minutes, oninput: (e) => { d.minutes = +e.target.value || 0; upd(); } })),
          h('td', {}, h('input', { type: 'checkbox', checked: d.pool, onchange: (e) => (d.pool = e.target.checked) })),
          h('td', {}, h('input', { type: 'checkbox', checked: d.gym, onchange: (e) => (d.gym = e.target.checked) }))))))),
      h('p', { style: 'margin-top:10px' }, total),
      h('p', { class: 'muted small' }, 'Long ride and long run go to your biggest days. Set a day to 0 to keep it free. Days with 4+ hours can take three sessions.')),
    card('Exceptions (travel, work, family)',
      ov.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Minutes', 'Note', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, ov.map((o, i) => h('tr', {}, h('td', {}, h('input', { type: 'date', value: o.date, oninput: (e) => (o.date = e.target.value) })),
          h('td', {}, h('input', { type: 'number', min: 0, max: 600, step: 15, value: o.minutes, oninput: (e) => (o.minutes = +e.target.value || 0) })),
          h('td', {}, h('input', { value: o.note ?? '', placeholder: 'e.g. travel', oninput: (e) => (o.note = e.target.value) })),
          h('td', {}, h('button', { class: 'btn sm danger', onclick: () => { ov.splice(i, 1); render(); } }, '✕'))))))) : h('p', { class: 'muted' }, 'No exceptions.'),
      h('div', { class: 'row', style: 'margin-top:10px' }, btn('Add exception', () => { ov.push({ date: addDays(S.today, 7), minutes: 0, note: '' }); render(); }))),
    h('div', { class: 'row' }, btn('Save availability', save, 'primary')),
  ];
}

// ---------------- Workouts ----------------
const newStep = (sport) => ({ kind: 'work', unit: sport === 'swim' ? 'm' : 'min', amount: sport === 'swim' ? 100 : 5, lo: 95, hi: 100, cue: '' });
function vWorkouts() {
  const b = draft.builder ??= { sport: 'bike', name: '', description: '', blocks: [{ name: 'Warm-up', repeat: 1, steps: [{ kind: 'warmup', unit: 'min', amount: 10, lo: 50, hi: 70, cue: '' }] }, { name: 'Main set', repeat: 4, steps: [newStep('bike'), { kind: 'recovery', unit: 'min', amount: 3, lo: 50, hi: 55, cue: '' }] }] };
  const thr = { bike: 'FTP', run: S.profile.runTarget === 'pace' ? 'threshold pace' : S.profile.runTarget === 'hr' ? 'threshold (mapped to HR)' : 'run threshold power', swim: 'CSS speed' }[b.sport];
  const payload = () => ({ sport: b.sport, name: b.name, description: b.description, blocks: b.blocks.map((bl) => ({ name: bl.name, repeat: +bl.repeat || 1, steps: bl.steps.map((s) => ({
    kind: s.kind, lo: s.lo / 100, hi: Math.max(s.lo, s.hi) / 100, cue: s.cue,
    ...(s.unit === 'm' && s.kind !== 'rest' ? { meters: +s.amount } : { secs: s.unit === 'min' ? Math.round(s.amount * 60) : +s.amount }) })) })) });
  const n = (obj, key, attrs = {}) => h('input', { type: 'number', value: obj[key], oninput: (e) => (obj[key] = +e.target.value), style: 'width:74px', ...attrs });
  const builder = card('Workout builder',
    h('div', { class: 'form' },
      field('Sport', h('select', { onchange: (e) => { b.sport = e.target.value; render(); } }, ['bike', 'run', 'swim'].map((s) => h('option', { value: s, selected: b.sport === s }, SPORT[s])))),
      field('Name', h('input', { value: b.name, placeholder: 'e.g. 4×8 threshold', oninput: (e) => (b.name = e.target.value) })),
      field('Notes', h('input', { value: b.description, oninput: (e) => (b.description = e.target.value) }))),
    h('p', { class: 'muted small', style: 'margin-top:10px' }, `Intensity is % of ${thr}. Targets are converted to watts / pace / heart rate from your current thresholds and exported as structured steps.`),
    b.blocks.map((bl, bi) => h('div', { class: 'card', style: 'background:var(--panel2);margin-top:10px' },
      h('div', { class: 'row' }, field('Block', h('input', { value: bl.name, oninput: (e) => (bl.name = e.target.value) })), field('Repeat ×', n(bl, 'repeat', { min: 1, max: 100 })),
        h('button', { class: 'btn sm danger right', onclick: () => { b.blocks.splice(bi, 1); render(); } }, 'Remove block')),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Type', 'Length', 'Unit', 'From %', 'To %', 'Cue', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, bl.steps.map((s, si) => h('tr', {},
          h('td', {}, h('select', { onchange: (e) => (s.kind = e.target.value) }, ['warmup', 'work', 'recovery', 'cooldown', 'rest'].map((k) => h('option', { value: k, selected: s.kind === k }, k)))),
          h('td', {}, n(s, 'amount', { min: 1, step: 'any' })),
          h('td', {}, h('select', { onchange: (e) => (s.unit = e.target.value) }, [['min', 'min'], ['sec', 'sec'], ...(b.sport === 'swim' ? [['m', 'metres']] : [])].map(([v, l]) => h('option', { value: v, selected: s.unit === v }, l)))),
          h('td', {}, n(s, 'lo', { min: 30, max: 250 })), h('td', {}, n(s, 'hi', { min: 30, max: 250 })),
          h('td', {}, h('input', { value: s.cue, placeholder: 'optional', oninput: (e) => (s.cue = e.target.value) })),
          h('td', {}, h('button', { class: 'btn sm danger', onclick: () => { bl.steps.splice(si, 1); render(); } }, '✕'))))))),
      h('div', { style: 'margin-top:8px' }, btn('Add step', () => { bl.steps.push(newStep(b.sport)); render(); }, 'sm')))),
    h('div', { class: 'row', style: 'margin-top:12px' },
      btn('Add block', () => { b.blocks.push({ name: 'Block', repeat: 1, steps: [newStep(b.sport)] }); render(); }),
      btn('Save to library', () => act(() => api('POST', '/api/library', { workout: payload() }), 'Saved to library').then(() => delete draft.builder), 'primary')));
  const lib = card('Your library',
    S.library.length ? S.library.map((l) => {
      const date = h('input', { type: 'date', value: S.today });
      return h('div', { class: l.workout.sport, style: 'border-left:4px solid var(--c);padding-left:12px;margin-bottom:14px' },
        h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, l.workout.name), h('span', { class: 'pill' }, `${SPORT[l.workout.sport]} · ${meta(l.workout)}`),
          h('button', { class: 'btn sm right', onclick: () => openDialog(l.workout.sport, l.workout.name, [workoutDetail(l.workout), h('pre', { class: 'icu' }, l.workout.icu)]) }, 'View'),
          h('button', { class: 'btn sm danger', onclick: () => confirm('Delete this workout?') && act(() => api('DELETE', `/api/library/${l.id}`), 'Deleted') }, 'Delete')),
        h('div', { class: 'row', style: 'margin-top:6px' }, date, btn('Schedule', () => act(() => api('POST', '/api/sessions', { date: date.value, libraryId: l.id }), `Scheduled for ${fmtDate(date.value)}`), 'sm')));
    }) : h('p', { class: 'muted' }, 'Nothing saved yet. Custom workouts you schedule are pinned: re-planning works around them.'));
  return [page('Workouts', 'Build your own sessions by power, pace or heart rate and drop them into the plan.'), lib, builder];
}

// ---------------- Strength ----------------
function vStrength() {
  const next = S.sessions.find((x) => x.sport === 'strength' && x.date >= S.today && x.status === 'planned');
  return [
    page('Strength programme', 'Periodised with the season: adaptation → maximal strength → power → in-season maintenance.'),
    next && h('div', { class: 'notice info' }, `Next strength session: ${next.workout.name} on ${fmtDate(next.date)}.`),
    ...S.strength.map((b) => card(b.title, h('p', {}, b.aim), h('p', { class: 'muted small' }, b.dosing),
      h('div', { class: 'grid g2' }, b.sessions.map((w) => h('div', {}, h('h3', {}, w.name.split(' · ')[0]),
        h('table', {}, h('tbody', {}, w.exercises.map((e) => h('tr', {}, h('td', {}, e.name, e.note && h('div', { class: 'muted small' }, e.note)), h('td', { class: 'num', style: 'white-space:nowrap' }, e.sets), h('td', { class: 'small' }, e.load)))))))))),
    card('Rules', h('ul', { class: 'clean' },
      h('li', {}, 'Lift heavy with full recoveries. Light, high-rep circuits add fatigue without the neural adaptation you are after.'),
      h('li', {}, 'Same day as a hard endurance session (endurance first, 6+ hours apart if you can), so easy days stay easy.'),
      h('li', {}, 'Never to failure, and nothing heavy within 3 days of an A-race.'),
      h('li', {}, 'Calf and Achilles loading is non-negotiable while run volume is returning.'))),
  ];
}

// ---------------- Profile ----------------
function vProfile() {
  const p = draft.profile ??= structuredClone(S.profile);
  const num = (key, attrs = {}) => h('input', { type: 'number', value: p[key] ?? '', oninput: (e) => (p[key] = e.target.value === '' ? null : +e.target.value), ...attrs });
  const pace = (key, ph) => h('input', { value: clock(p[key]), placeholder: ph, onchange: (e) => (p[key] = parseClock(e.target.value)) });
  const sel = (obj, key, opts) => h('select', { onchange: (e) => (obj[key] = e.target.value) }, Object.entries(opts).map(([v, l]) => h('option', { value: v, selected: obj[key] === v }, l)));
  const zt = (title, rows) => h('div', {}, h('h3', {}, title), h('table', {}, h('tbody', {}, rows.map((z) => h('tr', {}, h('td', {}, h('b', {}, z.id)), h('td', {}, z.name), h('td', { class: 'num muted' }, z.pct), h('td', { class: 'num' }, z.target))))));
  return [
    page('Profile & zones', S.intervals.connected && p.autoThresholds ? 'Thresholds are synced from Intervals.icu.' : 'Your thresholds drive every target in the plan.'),
    card('Athlete', h('div', { class: 'form' },
      field('Name', h('input', { value: p.name, oninput: (e) => (p.name = e.target.value) })),
      field('Birth year', num('birthYear', { min: 1930, max: 2015 })), field('Sex', sel(p, 'sex', { '': '—', m: 'Male', f: 'Female' })), field('Weight (kg)', num('weightKg', { step: 0.1 })))),
    card('Thresholds', h('div', { class: 'form' },
      field('Bike FTP (W)', num('ftp')), field('Bike LTHR (bpm)', num('bikeLthr')),
      field('Run threshold power (W)', num('runPower')), field('Run threshold pace (min:ss /km)', pace('runPaceSecPerKm', '3:55')), field('Run LTHR (bpm)', num('runLthr')),
      field('Swim CSS (min:ss /100 m)', pace('cssSecPer100', '1:32')),
      field('Bike targets by', sel(p, 'bikeTarget', { power: 'Power', hr: 'Heart rate' })),
      field('Run targets by', sel(p, 'runTarget', { power: 'Power', pace: 'Pace', hr: 'Heart rate' })),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: p.autoThresholds, onchange: (e) => (p.autoThresholds = e.target.checked) }), 'Keep in sync with Intervals.icu')),
      h('p', { class: 'muted small', style: 'margin-top:10px' }, 'After a lay-off your old numbers are probably too high. The plan schedules tests at the end of the rebuild block; until then, knock 5–8% off pre-break thresholds.')),
    card('Training load', h('div', { class: 'form' },
      field('Max weekly hours', num('maxWeeklyHours', { min: 3, max: 35, step: 0.5 })),
      field('Current weekly hours (last 4 weeks)', num('currentWeeklyHours', { min: 0, max: 35, step: 0.5 })),
      field('Progression rate', sel(p, 'ramp', { conservative: 'Conservative (~3 CTL/wk)', moderate: 'Moderate (~4 CTL/wk)', aggressive: 'Aggressive (~5 CTL/wk)' })),
      field('Recovery cycle', sel(p, 'recoveryCycle', { auto: 'Auto (by age)', '3:1': '3 weeks on, 1 easy', '2:1': '2 weeks on, 1 easy' })),
      field('Limiter (gets extra time)', sel(p, 'limiter', { none: 'Balanced', swim: 'Swim', bike: 'Bike', run: 'Run' })),
      field('Strength equipment', sel(p, 'strengthEquipment', { gym: 'Full gym (barbell)', home: 'Home (dumbbells, bands)' })),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: p.restDay, onchange: (e) => (p.restDay = e.target.checked) }), 'Protect one full rest day per week')),
      S.ctl != null && h('p', { class: 'muted small', style: 'margin-top:10px' }, `Starting fitness is taken from Intervals.icu (CTL ${S.ctl.toFixed(0)}), not from the hours above.`)),
    card('Return to training', h('div', { class: 'form' },
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: p.comeback.active, onchange: (e) => (p.comeback.active = e.target.checked) }), 'I am coming back from a break'),
      field('Weeks off / heavily reduced', h('input', { type: 'number', min: 0, max: 104, value: p.comeback.weeksOff, oninput: (e) => (p.comeback.weeksOff = +e.target.value || 0) })),
      field('Resumed training on', h('input', { type: 'date', value: p.comeback.resumedOn ?? '', oninput: (e) => (p.comeback.resumedOn = e.target.value || null) })),
      field('Notes (private)', h('input', { value: p.comeback.note ?? '', oninput: (e) => (p.comeback.note = e.target.value) }))),
      h('p', { class: 'muted small', style: 'margin-top:10px' }, 'Sets the length of the rebuild block (2–6 weeks): aerobic volume and strength first, bike intensity from week 2, run intensity last. Weeks already served since you resumed are credited. Untick once you are through it.')),
    h('div', { class: 'row', style: 'margin-bottom:14px' }, btn('Save profile', () => saveAndReplan('PUT', '/api/profile', p, 'Profile saved.').then(() => delete draft.profile), 'primary')),
    card('Your zones', h('div', { class: 'grid g3' }, zt('Bike', S.zones.bike), zt('Run', S.zones.run), zt('Swim', S.zones.swim))),
  ];
}

// ---------------- Connect ----------------
function vConnect() {
  const i = S.intervals;
  const key = h('input', { type: 'password', placeholder: 'API key', autocomplete: 'off', style: 'min-width:260px' });
  const id = h('input', { placeholder: 'Athlete ID, e.g. i123456 (optional)', value: i.athleteId ?? '' });
  const when = (t) => (t ? new Date(t).toLocaleString() : 'never');
  return [
    page('Connect', 'Intervals.icu is the hub: data comes in from it, planned workouts go out through it to your devices.'),
    card('Intervals.icu',
      i.connected
        ? [h('div', { class: 'row' }, h('span', { class: 'pill good' }, 'Connected'), h('span', {}, `${i.athleteName || ''} ${i.athleteId ? `(${i.athleteId})` : ''}`)),
          h('p', { class: 'muted small', style: 'margin-top:8px' }, `Last sync: ${when(i.lastSync)} · Last push: ${when(i.lastPush)} · ${i.activityCount} activities imported${i.historyFrom ? ` since ${fmtDate(i.historyFrom, true)}` : ''}`),
          i.hidden > 0 && hiddenNotice(),
          h('div', { class: 'row' },
            btn('Sync now', () => act(() => api('POST', '/api/intervals/sync', {}), (r) => `Synced: ${r.activities} activities in total, matched ${r.matched}${r.thresholdsUpdated.length ? `, updated ${r.thresholdsUpdated.join(', ')}` : ''}${r.importedRaces ? `, imported ${r.importedRaces} race(s)` : ''}`), 'primary'),
            btn('Re-import full history', () => act(() => api('POST', '/api/intervals/sync', { full: true }), (r) => `Imported ${r.activities} activities back to ${r.historyFrom}`)),
            btn('Push next 14 days', () => act(() => api('POST', '/api/intervals/push', { days: 14 }), (r) => `Pushed ${r.pushed} workouts${r.removed ? `, removed ${r.removed} stale` : ''}`)),
            btn('Disconnect', () => confirm('Remove the stored API key?') && act(() => api('DELETE', '/api/intervals'), 'Disconnected'), 'danger'))]
        : [h('p', {}, 'In Intervals.icu open Settings → Developer Settings, create an API key and paste it here. Your athlete ID is shown on the same page.'),
          h('div', { class: 'row' }, key, id, btn('Connect', () => act(() => api('POST', '/api/intervals/connect', { apiKey: key.value, athleteId: id.value }), (r) => `Connected. ${r.activities} activities synced.`), 'primary')),
          h('p', { class: 'muted small', style: 'margin-top:8px' }, 'The key is stored only on the machine running this app (data/state.json, owner-readable) and is never sent to the browser or anywhere except intervals.icu.')]),
    card('AI coach (Claude)',
      h('div', { class: 'row' }, h('span', { class: `pill ${S.coach.configured ? 'good' : ''}` }, S.coach.configured ? 'Ready' : 'Not set up'), h('span', { class: 'muted small' }, `Model: ${S.coach.model}`)),
      h('p', { style: 'margin-top:8px' }, 'The coach can discuss your plan, explain sessions and change workouts for you. It needs an Anthropic API key (console.anthropic.com → API keys); usage is billed to that key.'),
      (() => { const k = h('input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', style: 'min-width:260px' });
        return h('div', { class: 'row' }, k, btn('Save key', () => act(() => api('PUT', '/api/coach/key', { apiKey: k.value }), k.value ? 'Key saved' : 'Key removed'), 'primary'),
          S.coach.configured && btn('Remove key', () => act(() => api('PUT', '/api/coach/key', { apiKey: '' }), 'Key removed'), 'danger')); })(),
      h('p', { class: 'muted small', style: 'margin-top:8px' }, 'Stored only in data/state.json on this machine, never sent to the browser. Alternatively set ANTHROPIC_API_KEY in the environment. Each message sends your plan, thresholds, recent training and readiness to the Claude API.')),
    card('What syncs',
      h('ul', { class: 'clean' },
        h('li', {}, h('b', {}, 'In: '), 'thresholds (FTP, run power, threshold pace, CSS, LTHR), your full activity history and fitness/fatigue (CTL/ATL) back to your first recorded activity, HRV, resting HR, sleep, subjective wellness, and races on your calendar. The first sync imports everything; later syncs refresh the last 60 days.'),
        h('li', {}, h('b', {}, 'Out: '), 'planned workouts as structured steps on your Intervals.icu calendar. Re-pushing updates them in place and removes ones you deleted here. Nothing else on your calendar is touched.'))),
    card('Getting workouts onto your devices',
      h('ul', { class: 'clean' },
        h('li', {}, h('b', {}, 'Apple Watch: '), 'Intervals.icu does not talk to the Watch directly. Install a bridge app that reads your Intervals.icu calendar and sends structured workouts to the Watch — Intervals Companion (sends to the native Workout app via WorkoutKit) or Watchletic. Pushed workouts then appear on the watch with power/pace/HR targets. Check each app’s notes for run-power and pace-target support on your watchOS version.'),
        h('li', {}, h('b', {}, 'Garmin, Wahoo, Suunto, COROS, Zwift, etc.: '), 'enable “upload planned workouts” for the service under Intervals.icu → Settings → Connections; workouts sync automatically after each push.'),
        h('li', {}, h('b', {}, 'Run power: '), 'targets are sent as % of your run threshold power in Intervals.icu (set it under the Run sport settings, with power as the preferred target) — works with Apple Watch native running power or Stryd.'),
        h('li', {}, h('b', {}, 'Any calendar: '), h('a', { href: '/api/plan.ics' }, 'download the plan as .ics'), ' for Apple/Google Calendar.'))),
  ];
}

const hiddenNotice = () => h('div', { class: 'notice' },
  `${S.intervals.hidden} of your activities reached Intervals.icu through Strava. Strava’s terms stop Intervals.icu from passing those on, so they cannot be imported here (their load still counts in your fitness numbers). To get them: connect Garmin / Wahoo / Zwift / Apple Health directly to Intervals.icu, or bulk-upload your Strava export archive to Intervals.icu, then re-import.`);

// ---------------- Coach ----------------
const coach = { pending: null, changes: [], input: '' };
function askCoach(text) { coach.input = text; go('coach'); }
async function sendCoach() {
  const text = coach.input.trim();
  if (!text || coach.pending) return;
  coach.pending = text; coach.input = ''; coach.changes = [];
  render();
  try {
    const r = await api('POST', '/api/coach', { message: text });
    coach.changes = r.changes;
  } catch (e) { toast(e.message, true); coach.input = text; }
  coach.pending = null;
  await load();
}
function vCoach() {
  if (!S.coach.configured) return [page('Coach', 'Talk through your plan with Claude.'), card(null, h('p', {}, 'Add an Anthropic API key to switch the coach on.'), btn('Set up under Connect', () => go('connect'), 'primary'))];
  const msgs = [...S.coach.messages, ...(coach.pending ? [{ role: 'user', text: coach.pending }] : [])];
  const ta = h('textarea', { placeholder: 'Ask about the plan, a session, or tell the coach what to change…', value: coach.input, rows: 3,
    oninput: (e) => (coach.input = e.target.value), onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCoach(); } } });
  const ideas = ['Why is this week structured the way it is?', 'I only have 45 minutes tomorrow — adjust the session.', 'Make Saturday’s long ride harder; I feel good.',
    'Compare my last 8 weeks with my best block. Am I ramping too fast?', 'I’m travelling Thursday and Friday next week with no bike. Re-plan around it.'];
  const log = h('div', { class: 'chat' },
    msgs.length ? msgs.map((m) => h('div', { class: `msg ${m.role}` }, m.text)) : h('div', { class: 'muted' }, 'The coach sees your profile, season, the next two weeks, recent training and today’s readiness, and can look up the rest. It can move, change, add or skip sessions when you ask.'),
    coach.pending && h('div', { class: 'msg assistant muted' }, 'Thinking…'),
    !coach.pending && coach.changes.length ? h('div', { class: 'notice good' }, h('b', {}, 'Plan changed: '), coach.changes.join(' '), ' ', h('a', { href: '#plan' }, 'View plan'), S.intervals.connected ? ' — push to Intervals.icu from there to update your devices.' : '') : null);
  setTimeout(() => { log.scrollTop = log.scrollHeight; if (!coach.pending) ta.focus(); });
  return [
    page('Coach', `Claude (${S.coach.model}) with access to your plan and history.`,
      S.coach.messages.length ? btn('New conversation', () => confirm('Clear this conversation?') && act(() => api('DELETE', '/api/coach'), 'Conversation cleared').then(() => (coach.changes = []))) : null),
    h('div', { class: 'card' }, log,
      !msgs.length && h('div', { class: 'row', style: 'margin:10px 0' }, ideas.map((t) => h('button', { class: 'btn sm', onclick: () => { coach.input = t; sendCoach(); } }, t))),
      h('div', { class: 'row', style: 'margin-top:10px;align-items:flex-end' }, h('div', { style: 'flex:1;min-width:200px' }, ta), h('button', { class: 'btn primary', disabled: !!coach.pending, onclick: sendCoach }, 'Send'))),
  ];
}

// ---------------- History ----------------
const SPORT_KEYS = ['swim', 'bike', 'run', 'strength', 'other'];
async function loadHistory(reset) {
  const hs = draft.hist ??= { items: [], total: 0, sport: '' };
  if (reset) hs.items = [];
  try {
    const r = await api('GET', `/api/history?limit=50&offset=${hs.items.length}${hs.sport ? `&sport=${hs.sport}` : ''}`);
    hs.items.push(...r.items); hs.total = r.total; hs.loaded = true;
  } catch (e) { toast(e.message, true); }
  if (view === 'history') render();
}
function vHistory() {
  const H = S.history;
  if (!H) return [page('History'), card(null, h('p', {}, S.intervals.connected ? 'No activities were returned by Intervals.icu.' : 'Connect Intervals.icu to import your training history.'),
    S.intervals.hidden > 0 && hiddenNotice(), btn(S.intervals.connected ? 'Re-import full history' : 'Connect', () => S.intervals.connected ? act(() => api('POST', '/api/intervals/sync', { full: true }), 'History imported') : go('connect'), 'primary'))];
  const hs = draft.hist ??= { items: [], total: 0, sport: '' };
  if (!hs.loaded) loadHistory();
  // weekly stacked bars
  const W = 960, Ht = 220, padL = 30, padB = 22, padT = 16, weeks = H.weeks;
  const bw = (W - padL - 6) / Math.max(weeks.length, 1);
  const tot = (w) => SPORT_KEYS.reduce((t, k) => t + w.min[k], 0) / 60;
  const maxH = Math.max(4, ...weeks.map(tot));
  const y = (v) => padT + (Ht - padT - padB) * (1 - v / maxH);
  const g = svg('svg', { viewBox: `0 0 ${W} ${Ht}`, style: 'width:100%;height:auto', role: 'img', 'aria-label': 'Weekly training hours by sport' });
  for (const v of [maxH / 2, maxH].map(Math.round)) g.append(svg('line', { x1: padL, x2: W, y1: y(v), y2: y(v), stroke: 'var(--line)' }), svg('text', { x: 2, y: y(v) + 4 }, `${v}h`));
  weeks.forEach((w, i) => {
    let acc = 0;
    for (const k of SPORT_KEYS) {
      const hrs = w.min[k] / 60;
      if (!hrs) continue;
      const r = svg('rect', { x: padL + i * bw + 1, y: y(acc + hrs), width: Math.max(1, bw - 2), height: y(acc) - y(acc + hrs), fill: k === 'other' ? 'var(--muted)' : `var(--${k})` });
      r.append(svg('title', {}, `Week of ${fmtDate(w.start, true)} · ${SPORT[k] || 'Other'} ${hm(w.min[k])} · total ${tot(w).toFixed(1)} h · ${w.tss} TSS`));
      g.append(r); acc += hrs;
    }
    if (+w.start.slice(8) <= 7) g.append(svg('text', { x: padL + i * bw, y: Ht - 6 }, MONTHS[+w.start.slice(5, 7) - 1]));
  });
  // all-time fitness line
  const c = H.ctlSeries, cH = 160;
  const cg = svg('svg', { viewBox: `0 0 ${W} ${cH}`, style: 'width:100%;height:auto', role: 'img', 'aria-label': 'Fitness over time' });
  if (c.length > 1) {
    const maxC = Math.max(...c.map((p) => p.ctl)) * 1.1, t0 = toDate(c[0].date).getTime(), t1 = toDate(c.at(-1).date).getTime();
    const cx = (d) => padL + ((toDate(d).getTime() - t0) / Math.max(1, t1 - t0)) * (W - padL - 6), cy = (v) => 8 + (cH - 30) * (1 - v / maxC);
    for (const v of [maxC / 2.2, maxC / 1.1].map(Math.round)) cg.append(svg('line', { x1: padL, x2: W, y1: cy(v), y2: cy(v), stroke: 'var(--line)' }), svg('text', { x: 2, y: cy(v) + 4 }, v));
    cg.append(svg('polyline', { fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, points: c.map((p) => `${cx(p.date)},${cy(p.ctl)}`).join(' ') }));
    let lastYear = '';
    for (const p of c) if (p.date.slice(0, 4) !== lastYear) { lastYear = p.date.slice(0, 4); cg.append(svg('text', { x: cx(p.date), y: cH - 6 }, lastYear)); }
  }
  const stat = (label, value, sub) => h('div', { class: 'card', style: 'margin:0' }, h('div', { class: 'label' }, label), h('div', { class: 'stat num' }, value), sub && h('div', { class: 'muted small' }, sub));
  const L = H.longest;
  const filter = h('select', { onchange: (e) => { hs.sport = e.target.value; loadHistory(true); } }, [['', 'All sports'], ...SPORT_KEYS.map((k) => [k, SPORT[k] || 'Other'])].map(([v, l]) => h('option', { value: v, selected: hs.sport === v }, l)));
  return [
    page('Training history', `${H.count} activities since ${fmtDate(H.from, true)}, imported from Intervals.icu.`,
      S.intervals.connected && btn('Sync now', () => act(() => api('POST', '/api/intervals/sync', {}), (r) => `${r.activities} activities in total`).then(() => loadHistory(true)))),
    S.intervals.hidden > 0 && hiddenNotice(),
    h('div', { class: 'grid g3', style: 'grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px' },
      stat('Last 4 weeks', `${H.avg4wkHours} h/wk`, `12-week average ${H.avg12wkHours} h/wk`),
      H.best6wk && stat('Best 6-week block', `${H.best6wk.hours} h/wk`, `ending ${fmtDate(H.best6wk.end, true)}`),
      H.peakCtl && stat('Peak fitness (CTL)', H.peakCtl.value.toFixed(0), `${fmtDate(H.peakCtl.date, true)}${S.ctl != null ? ` · now ${S.ctl.toFixed(0)}` : ''}`),
      ...['bike', 'run', 'swim'].filter((k) => L[k]).map((k) => stat(`Longest ${k} (12 mo)`, hm(L[k].min), `${L[k].km ? `${L[k].km} km · ` : ''}${fmtDate(L[k].date, true)}`))),
    card('Weekly volume — last 52 weeks', g, h('div', { class: 'legend' }, SPORT_KEYS.map((k) => h('span', {}, h('i', { style: `background:${k === 'other' ? 'var(--muted)' : `var(--${k})`}` }), SPORT[k] || 'Other')))),
    c.length > 1 && card('Fitness (CTL) — all time', cg),
    card('Year by year', h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Year', 'Sessions', 'Hours', 'Swim', 'Bike', 'Run', 'Strength', 'TSS'].map((x) => h('th', {}, x)))),
      h('tbody', {}, H.years.map((yr) => h('tr', {}, h('td', {}, h('b', {}, yr.year)), h('td', { class: 'num' }, yr.count), h('td', { class: 'num' }, SPORT_KEYS.reduce((t, k) => t + yr.hours[k], 0)),
        h('td', { class: 'num' }, `${yr.hours.swim} h · ${yr.km.swim} km`), h('td', { class: 'num' }, `${yr.hours.bike} h · ${yr.km.bike} km`), h('td', { class: 'num' }, `${yr.hours.run} h · ${yr.km.run} km`),
        h('td', { class: 'num' }, `${yr.hours.strength} h`), h('td', { class: 'num' }, yr.tss))))))),
    card('Activities', h('div', { class: 'row', style: 'margin-bottom:8px' }, filter, h('span', { class: 'muted small' }, `${hs.items.length} of ${hs.total}`)),
      h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Date', 'Sport', 'Activity', 'Time', 'Distance', 'TSS', 'NP', 'Avg HR', 'IF'].map((x) => h('th', {}, x)))),
        h('tbody', {}, hs.items.map((a) => h('tr', { class: a.sport }, h('td', { class: 'num', style: 'white-space:nowrap' }, fmtDate(a.date, true)),
          h('td', {}, h('span', { class: 'row', style: 'flex-wrap:nowrap' }, h('span', { class: 'dot', style: `background:var(--c, var(--muted))` }), a.type || a.sport)), h('td', {}, a.name),
          h('td', { class: 'num' }, hm(a.durationMin)), h('td', { class: 'num' }, a.distanceKm ? `${a.distanceKm} km` : ''), h('td', { class: 'num' }, a.tss || ''),
          h('td', { class: 'num' }, a.np ? `${Math.round(a.np)} W` : ''), h('td', { class: 'num' }, a.avgHr ? Math.round(a.avgHr) : ''), h('td', { class: 'num' }, a.intensity ?? '')))))),
      hs.items.length < hs.total && h('div', { style: 'margin-top:10px' }, btn('Show more', () => loadHistory()))),
  ];
}

function vMethod() {
  return [page('Method', 'The training philosophy and the science behind it.'), $('#method').content.cloneNode(true)];
}

load().then(autoSync).catch((e) => { $('#main').replaceChildren(h('div', { class: 'notice bad' }, `Could not load: ${e.message}`)); });
