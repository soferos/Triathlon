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
const RACE_TYPES = { sprint: 'Sprint triathlon', olympic: 'Olympic triathlon', half: '70.3 / half', full: 'Ironman / full', duathlonSprint: 'Duathlon — sprint (5/20/2.5 km)', duathlon: 'Duathlon — standard (10/40/5 km)', aquathlon: 'Aquathlon (swim–run)', run10k: '10 km run', halfMarathon: 'Half marathon', marathon: 'Marathon', bikeEvent: 'Bike event / TT', other: 'Other' };

let S = null;
let view = location.hash.slice(1) || 'today';
let planWeek = null; // index into S.weekStats; null = the current week
const draft = {}; // unsaved form state per view

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
// A toast can carry one action (used for Undo).
function toast(msg, bad, action) {
  const t = $('#toast');
  t.replaceChildren(...[h('span', {}, msg), action && h('button', { class: 'btn sm', onclick: () => { t.style.display = 'none'; action.run(); } }, action.label)].filter(Boolean));
  t.className = bad ? 'bad' : ''; t.style.display = 'flex';
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), bad ? 7000 : action ? 8000 : 3200);
}
async function load() { S = await api('GET', '/api/state'); render(); }
// Pull new activities from Intervals.icu without being asked: on open and when the tab regains focus, at most every 10 minutes.
let syncing = false;
async function autoSync() {
  if (!S?.intervals.connected || syncing || document.hidden) return;
  if (S.intervals.lastSync && Date.now() - new Date(S.intervals.lastSync).getTime() < 10 * 60 * 1000) return;
  syncing = true; renderNav();
  try {
    const r = await api('POST', '/api/intervals/sync', {});
    syncing = false;
    await load();
    if (r.adapted?.length) toast(`Plan adapted: ${r.adapted.join(' ')}`, false, { label: 'Undo', run: doUndo });
    else if (r.graded) toast(`${r.graded} key ${r.graded === 1 ? 'session' : 'sessions'} graded against the plan`);
    else if (r.matched) toast(`${r.matched} completed ${r.matched === 1 ? 'activity' : 'activities'} matched to your plan`);
  } catch { syncing = false; await load().catch(() => {}); }
}
document.addEventListener('visibilitychange', autoSync);
// Run an action, reload, confirm. If the action left an undo point, the confirmation offers Undo.
async function act(fn, ok) {
  const before = S?.undo?.at;
  try {
    const r = await fn(); await load();
    const undoable = S.undo && S.undo.at !== before;
    if (ok) toast(typeof ok === 'function' ? ok(r) : ok, false, undoable ? { label: 'Undo', run: doUndo } : null);
    return r;
  } catch (e) { toast(e.message, true); }
}
const doUndo = () => act(() => api('POST', '/api/undo', {}), (r) => `Undone: ${r.label}`);
// Saving inputs that shape the plan regenerates future weeks (the current week is left alone).
const saveAndReplan = (method, path, body, msg) => act(async () => {
  await api(method, path, body);
  if (S.season) await api('POST', '/api/plan/generate', {});
}, S.season ? `${msg} Future weeks re-planned.` : msg);

// Five destinations; Progress and Setup hold sub-pages.
const NAV = [['today', 'Today'], ['plan', 'Plan'], ['coach', 'Coach'], ['progress', 'Progress'], ['setup', 'Setup']];
const GROUPS = {
  progress: [['overview', 'Overview'], ['season', 'Season'], ['history', 'History'], ['insights', 'Insights']],
  setup: [['profile', 'Profile & zones'], ['availability', 'Availability'], ['races', 'Races & goals'], ['workouts', 'Workouts'], ['strength', 'Strength'], ['connect', 'Connect'], ['method', 'Method']],
};
const groupOf = (v) => Object.keys(GROUPS).find((g) => GROUPS[g].some(([id]) => id === v));
const lastSub = {};
// Unsaved edits: views that keep a draft register a save function and show a save bar once touched.
const dirty = {}, savers = {};
const DRAFTS = { profile: ['profile'], availability: ['availability', 'overrides', 'preview'], races: ['races', 'goals'] };
function setDirty(v, on = true) { dirty[v] = on; const bar = $('#savebar'); if (bar) bar.hidden = !dirty[view]; }
function discard(v) { for (const k of DRAFTS[v] || []) delete draft[k]; setDirty(v, false); }
function go(v) {
  if (GROUPS[v]) v = lastSub[v] || GROUPS[v][0][0];
  if (v === view) return;
  if (dirty[view]) { if (!confirm('You have unsaved changes on this page. Leave without saving?')) { location.hash = view; return; } discard(view); }
  view = v; location.hash = v; render(); window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v && v !== view) go(v); });
window.addEventListener('beforeunload', (e) => { if (dirty[view]) e.preventDefault(); });
document.addEventListener('input', (e) => { if (DRAFTS[view] && e.target.closest('#main') && !e.target.closest('[data-nodraft]')) setDirty(view); });
document.addEventListener('change', (e) => { if (DRAFTS[view] && e.target.closest('#main') && !e.target.closest('[data-nodraft]')) setDirty(view); });

function renderNav() {
  const g = groupOf(view);
  $('#nav').replaceChildren(h('div', { class: 'brand' }, 'Triathlon Coach', syncing ? h('div', { class: 'muted small syncing' }, 'Syncing…') : null),
    ...NAV.map(([id, label]) => h('button', { class: id === view || id === g ? 'on' : '', onclick: () => go(id) }, label,
      id === 'plan' && S?.unsynced && !S.unsynced.never && S.unsynced.changed + S.unsynced.removed > 0 ? h('span', { class: 'badge', title: 'Changes not yet on your devices' }, S.unsynced.changed + S.unsynced.removed) : null,
      id === 'today' && S?.adaptations?.length ? h('span', { class: 'badge', title: 'Suggested adjustments' }, S.adaptations.length) : null)));
}
function render() {
  const g = groupOf(view);
  if (g) lastSub[g] = view;
  renderNav();
  const fn = { overview: vOverview, insights: vInsights, coach: vCoach, history: vHistory, today: vToday, plan: vPlan, season: vSeason, races: vRaces, availability: vAvailability, workouts: vWorkouts, strength: vStrength, profile: vProfile, connect: vConnect, method: vMethod }[view] || vToday;
  delete savers[view];
  const body = [fn()].flat(Infinity).filter((x) => x != null && x !== false);
  $('#main').replaceChildren(...[
    g && h('div', { class: 'subtabs' }, GROUPS[g].map(([id, label]) => h('button', { class: id === view ? 'on' : '', onclick: () => go(id) }, label))),
    ...body,
    savers[view] && h('div', { id: 'savebar', hidden: !dirty[view] }, h('span', {}, 'Unsaved changes'), btn('Discard', () => { discard(view); render(); }), btn('Save', savers[view], 'primary')),
  ].filter(Boolean));
}
const page = (title, sub, ...actions) => h('header', { class: 'page' }, h('div', {}, h('h1', {}, title), sub && h('div', { class: 'sub' }, sub)), h('div', { class: 'row right' }, actions));
const card = (title, ...kids) => h('div', { class: 'card' }, title && h('h2', {}, title), kids);
const field = (label, input) => h('label', { class: 'f' }, label, input);
// Buttons whose handler returns a promise disable themselves and show progress until it settles.
const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, onclick: (e) => {
  const el = e.currentTarget, r = onclick(e);
  if (r && typeof r.then === 'function') { el.disabled = true; el.classList.add('busy'); r.finally(() => { el.disabled = false; el.classList.remove('busy'); }); }
} }, label);
// A small "More" menu for secondary actions.
const menu = (label, items) => h('details', { class: 'menu' }, h('summary', { class: 'btn' }, label),
  h('div', { class: 'menu-items' }, items.filter(Boolean).map(([text, run, cls]) => h('button', { class: cls || '', onclick: (e) => { e.currentTarget.closest('details').open = false; run(); } }, text))));
const fmtWhen = (iso) => (iso ? `${fmtDate(iso.slice(0, 10))} ${new Date(iso).toTimeString().slice(0, 5)}` : 'never');
// Plain-text coach output with "- " lists and **bold**, rendered as DOM nodes (never as HTML).
function rich(text) {
  const out = [], inline = (t) => t.split(/(\*\*[^*]+\*\*)/).map((p) => (p.startsWith('**') && p.endsWith('**') && p.length > 4 ? h('b', {}, p.slice(2, -2)) : p));
  let list = null;
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*[-•]\s+(.*)$/);
    if (m) { if (!list) out.push((list = h('ul', { class: 'clean' }))); list.append(h('li', {}, inline(m[1]))); continue; }
    list = null;
    if (line.trim()) out.push(h('p', {}, inline(line.replace(/^#+\s*/, ''))));
  }
  return out;
}

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
    a ? [h('div', { class: 'm did' }, `Did: ${actualLine(a)}`), h('div', { class: 'm' }, `Planned ${meta(x.workout)}${verdict(x) ? ` · ${verdict(x)}` : ''}${a.exec && a.exec.verdict !== 'unstructured' ? ` · reps ${EXEC[a.exec.verdict]}` : ''}`)]
      : h('div', { class: 'm' }, `${SPORT[x.sport]} · ${meta(x.workout)}${x.origin === 'adapted' ? ' · adapted' : x.origin === 'custom' ? ' · custom' : ''}${missed ? ' · not done' : ''}`));
}
// Proposed changes to the rest of the week, based on what was actually done.
function adaptCards() {
  const list = S.adaptations || [];
  if (!list.length) return null;
  const any = list.some((a) => a.actionable);
  return h('div', { class: 'card adapt' },
    h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Suggested adjustments'), h('span', { class: 'muted small' }, 'from what you have done and logged this week'),
      any && h('span', { class: 'right' }, btn(list.length > 1 ? 'Apply all' : 'Apply', () => act(() => api('POST', '/api/adapt/apply', {}), (r) => r.changes.join(' ') || 'Noted'), 'primary'))),
    list.map((a) => h('div', { class: 'signal' }, h('span', { class: `pill ${a.kind === 'missed' && !a.actionable ? '' : 'warn'}` }, { bigday: 'Big day', overload: 'Load', missed: 'Missed', niggle: 'Niggle' }[a.kind]),
      h('div', { style: 'flex:1' }, h('b', {}, a.title), h('div', { class: 'small' }, a.detail), a.actions.length ? h('ul', { class: 'clean small', style: 'margin-top:4px' }, a.actions.map((t) => h('li', {}, t))) : null),
      h('button', { class: 'btn sm', onclick: () => act(() => api('POST', '/api/adapt/dismiss', { key: a.key }), 'Left as planned') }, a.actionable ? 'Keep as planned' : 'OK'))));
}
// Average intensity (IF) the plan prescribed for a session, from its load per hour, against what was done.
const plannedIF = (x) => (x.workout.durationMin && x.workout.tss ? Math.round(Math.sqrt(x.workout.tss / (x.workout.durationMin / 60) / 100) * 100) / 100 : null);
function intensityNote(x) {
  const p = plannedIF(x), a = x.actual?.intensity;
  if (!p || !a || x.sport === 'strength' || Math.abs(a - p) < 0.08) return null;
  return a > p ? `Harder than prescribed: IF ${a} against ${p} planned${x.workout.hard ? '' : ' — an easy day was not easy'}.` : `Easier than prescribed: IF ${a} against ${p} planned${x.workout.hard ? ' — the quality was not there' : ''}.`;
}
const EXEC = { nailed: 'on target', over: 'above target', under: 'below target', 'cut short': 'cut short', unstructured: 'could not be graded' };
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
// Choose the planned session an activity really was; the session takes the activity's day and shows what you did.
function linkPicker(a) {
  const cands = S.sessions.filter((x) => x.sport === a.sport && !x.actual && x.status !== 'skipped' && Math.abs((toDate(x.date) - toDate(a.date)) / 864e5) <= 7)
    .sort((x, y) => Math.abs(toDate(x.date) - toDate(a.date)) - Math.abs(toDate(y.date) - toDate(a.date)));
  if (!cands.length) return h('p', { class: 'muted small' }, `No open ${SPORT[a.sport] || ''} session within a week of this one to link it to.`);
  const pick = h('select', {}, cands.map((x) => h('option', { value: x.id }, `${fmtDate(x.date)} · ${x.workout.name} (${hm(x.workout.durationMin)})`)));
  return h('div', { class: 'row', 'data-nodraft': '' }, field('Link it to', pick), btn('Link', () => act(() => api('POST', `/api/activities/${encodeURIComponent(a.id)}/link`, { sessionId: pick.value }), (r) => `Linked to “${r.name}”.${r.graded ? ` Graded against the plan: ${EXEC[r.verdict]}.` : r.gradeError ? ` Could not grade it: ${r.gradeError}` : ''}`).then(() => $('#dlg').close()), 'primary'));
}
function extraDialog(a) {
  openDialog(a.sport, a.name, [
    h('div', { class: 'row', style: 'margin-bottom:10px' }, h('span', { class: 'pill' }, fmtDate(a.date, true)), h('span', { class: 'pill good' }, 'Completed'), h('span', { class: 'pill' }, a.type || a.sport)),
    h('p', {}, actualLine(a), a.intensity ? ` · IF ${a.intensity}` : ''),
    h('p', { class: 'muted small' }, 'This activity was recorded in Intervals.icu but is not linked to a planned session (none of this sport was close enough, or you unlinked it). Its load still counts in your week and your fitness.'),
    linkPicker(a),
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
        h('tr', {}, h('td', {}, 'Planned'), h('td', { class: 'num' }, hm(x.workout.durationMin)), h('td', { class: 'num' }, `${x.workout.tss} TSS`), h('td', {}, ''), h('td', {}, ''), h('td', {}, ''), h('td', { class: 'num' }, plannedIF(x) ?? '')))),
      verdict(x) && h('div', { class: 'small', style: 'margin-top:6px' }, `Versus plan: ${verdict(x)}.`),
      intensityNote(x) && h('div', { class: 'small', style: 'margin-top:4px' }, intensityNote(x))),
    x.actual?.activityId && h('div', { class: 'row', style: 'margin:0 0 10px' }, h('span', { class: 'muted small' }, 'Not the session you did?'),
      btn('Unlink this activity', () => act(() => api('POST', `/api/sessions/${x.id}/unlink`, {}), (r) => `Unlinked${r.restoredDate ? ` — “${r.name}” is back on ${fmtDate(r.restoredDate)}` : ` — “${r.name}” is open again`}.`)
        .then(() => { const y = S.sessions.find((q) => q.id === x.id); if (y) sessionDialog(y); }), 'sm'),
      x.workout.hard && btn(x.actual.exec ? 'Re-grade' : 'Grade the reps', () => act(() => api('POST', `/api/sessions/${x.id}/regrade`, {}), (r) => `Graded: ${EXEC[r.verdict] ?? 'done'}.`).then(() => { const y = S.sessions.find((q) => q.id === x.id); if (y) sessionDialog(y); }), 'sm')),
    x.actual?.exec && h('div', { class: `notice ${x.actual.exec.verdict === 'nailed' ? 'good' : x.actual.exec.verdict === 'unstructured' ? 'info' : ''}` },
      h('b', {}, `Execution: ${EXEC[x.actual.exec.verdict]}`), h('div', { class: 'small', style: 'margin-top:4px' }, x.actual.exec.text)),
    x.actual?.decoupling != null && !x.workout.hard && h('div', { class: `notice ${Math.abs(x.actual.decoupling) <= 5 ? 'good' : ''}` },
      h('b', {}, `Aerobic decoupling ${x.actual.decoupling}%`), h('div', { class: 'small', style: 'margin-top:4px' }, Math.abs(x.actual.decoupling) <= 5
        ? 'Heart rate stayed coupled to output: you are aerobically durable at this duration and can extend it.' : 'Heart rate drifted against output in the second half: durability at this duration is still a limiter. Hold the length before adding more, and check fuelling and heat.')),
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
    x.status === 'planned' && x.date >= S.today && x.sport !== 'race' && x.sport !== 'strength' && h('div', { class: 'row', style: 'margin-top:10px' }, h('span', { class: 'muted small' }, 'Quick edit'),
      !x.workout.hard && btn('−15 min', () => patch({ minutes: x.workout.durationMin - 15 }, 'Shortened and pinned'), 'sm'),
      !x.workout.hard && btn('+15 min', () => patch({ minutes: x.workout.durationMin + 15 }, 'Lengthened and pinned'), 'sm'),
      x.workout.hard && btn('Make it easy', () => patch({ easy: true }, 'Replaced with an easy session'), 'sm')),
  ]);
}

// ---------------- Today ----------------
function vToday() {
  const t = S.today;
  const todays = S.sessions.filter((x) => x.date === t);
  const wk = S.season?.weeks[0];
  const out = [page(`Today · ${fmtDate(t, true)}`, wk ? `${PHASE[wk.phase]} phase${wk.recovery ? ' · recovery week' : ''}` : 'No plan yet')];
  if (!S.season) {
    const steps = [
      [S.intervals.connected, 'Connect Intervals.icu', 'pulls thresholds, history, fitness and HRV (optional, recommended)', 'connect'],
      [!S.needs.length, 'Check your thresholds', S.needs.length ? `missing: ${S.needs.join(', ')}` : 'FTP, run threshold and CSS are set', 'profile'],
      [!!S.profile.name || S.profile.comeback.resumedOn, 'Tell it about you', 'weekly hours you can train and how long you were off', 'profile'],
      [true, 'Shape your week', 'see the optimal week, then fix days or cap them if you need to', 'availability'],
      [S.races.some((r) => r.date >= t), 'Add your races', 'A-races drive the whole season; past races calibrate predictions', 'races'],
    ];
    out.push(card('Set up in five steps',
      steps.map(([ok, title, sub, to], i) => h('div', { class: 'signal' }, h('span', { class: `pill ${ok ? 'good' : ''}` }, ok ? '✓' : String(i + 1)),
        h('div', { style: 'flex:1' }, h('b', {}, title), h('div', { class: 'muted small' }, sub)), h('button', { class: 'btn sm', onclick: () => go(to) }, ok ? 'Review' : 'Open'))),
      h('div', { style: 'margin-top:14px' }, btn('Generate my plan', () => act(() => api('POST', '/api/plan/generate', {}), 'Plan generated'), 'primary'),
        h('span', { class: 'muted small', style: 'margin-left:10px' }, 'You can generate now and refine afterwards; every change re-plans.'))));
  }
  if (S.season && S.needs.length) out.push(h('div', { class: 'notice' }, `Missing thresholds: ${S.needs.join(', ')}. Targets show as % until set — `, h('a', { href: '#profile' }, 'add them'), ' or sync from Intervals.icu.'));
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

  const extrasToday = S.extras.filter((a) => a.date === t);
  const sessions = card('Today’s training',
    todays.map((x) => h('div', { class: x.sport, style: 'border-left:4px solid var(--c);padding-left:12px;margin-bottom:16px' },
      h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, x.workout.name), h('span', { class: 'pill' }, meta(x.workout)), x.status !== 'planned' && h('span', { class: `pill ${x.status === 'done' ? 'good' : ''}` }, x.status),
        h('button', { class: 'btn sm right', onclick: () => sessionDialog(x) }, 'Options')),
      x.adaptedNote && h('div', { class: 'muted small' }, x.adaptedNote),
      x.actual && h('div', { class: 'notice good', style: 'margin-top:6px' }, h('b', {}, 'Did: '), `${x.actual.name || 'activity'} — ${actualLine(x.actual)}${verdict(x) ? ` (${verdict(x)})` : ''}`),
      workoutDetail(x.workout))),
    !todays.length && !extrasToday.length && h('p', { class: 'muted' }, S.season ? 'Rest day. Sleep, eat, and leave it alone — this is where the adaptation happens.' : 'Nothing planned.'),
    extrasToday.map(extraCard));
  // What is coming next, so a rest day or a finished day still shows something useful.
  const nextDay = S.sessions.filter((x) => x.date > t && x.status === 'planned').map((x) => x.date)[0];
  const upcoming = nextDay && (!todays.some((x) => x.status === 'planned')) ? card(nextDay === addDays(t, 1) ? 'Tomorrow' : `Next: ${fmtDate(nextDay)}`, S.sessions.filter((x) => x.date === nextDay).map(sessCard)) : null;

  const ws = S.weekStats[S.currentWeek];
  const week = ws && !ws.past ? card('This week',
    h('div', { class: 'grid g2' },
      h('div', {}, h('div', { class: 'label' }, 'Load'), h('div', { class: 'stat num' }, `${ws.doneTss} / ${ws.plannedTss}`), h('div', { class: 'muted small' }, 'TSS done / planned')),
      h('div', {}, h('div', { class: 'label' }, 'Time'), h('div', { class: 'stat num' }, `${hm(ws.doneMin)} / ${hm(ws.plannedMin)}`), h('div', { class: 'muted small' }, `Key sessions ${ws.keyDone}/${ws.keyTotal}`))),
    h('p', { class: 'muted small', style: 'margin-top:10px' }, wk.focus),
    S.ctl != null && h('p', { class: 'muted small' }, `Fitness (CTL) ${S.ctl.toFixed(0)}${S.monotony ? ` · monotony ${S.monotony.monotony}${S.monotony.monotony > 2 ? ' (high: vary your days more)' : ''}` : ''}`)) : null;
  const race = S.nextRace ? card('Next race', h('div', { class: 'stat' }, `${S.nextRace.days} days`), h('div', {}, `${S.nextRace.name} · ${RACE_TYPES[S.nextRace.type]} · priority ${S.nextRace.priority}`), h('div', { class: 'muted small' }, fmtDate(S.nextRace.date, true))) : null;
  out.push(h('div', { class: 'grid g2' }, h('div', {}, adaptCards(), sessions, upcoming, week), h('div', {}, readiness, niggleCard(), debriefCard(), race)));
  return out;
}

// ---------------- Plan ----------------
// ---------------- Plan ----------------
function vPlan() {
  if (!S.season) return [page('Plan'), card(null, h('p', {}, 'No plan yet.'), btn('Generate my plan', () => act(() => api('POST', '/api/plan/generate', {}), 'Plan generated'), 'primary'))];
  const weeks = S.weekStats;
  if (planWeek == null || planWeek >= weeks.length) planWeek = S.currentWeek;
  const wk = weeks[planWeek], current = planWeek === S.currentWeek;
  const u = S.unsynced, pending = u ? u.changed + u.removed : 0;
  const push = () => act(() => api('POST', '/api/intervals/push', { days: 14 }), (r) => `Pushed ${r.pushed} workouts${r.removed ? `, removed ${r.removed} stale` : ''}`);
  const label = (w, i) => (i === S.currentWeek ? 'This week' : `${+w.start.slice(8)} ${MONTHS[+w.start.slice(5, 7) - 1]}`);
  const out = [page('Training plan',
    wk.past ? `Week of ${fmtDate(wk.start, true)} — review` : `${PHASE[wk.phase]}${wk.recovery ? ' · recovery week' : ''}${wk.testWeek ? ' · testing' : ''} — target ${wk.targetHours} h / ${wk.targetTss} TSS`,
    S.intervals.connected && btn(pending && !u.never ? `Push ${pending} change${pending === 1 ? '' : 's'}` : 'Push to devices', push, pending ? 'primary' : ''),
    menu('More', [
      ['Add a workout', () => addDialog(wk.start < S.today ? S.today : wk.start)],
      ['Re-plan future weeks', () => act(() => api('POST', '/api/plan/generate', {}), 'Future weeks re-planned')],
      ['Re-plan from today', () => confirm('Re-plan the rest of this week from today? Pinned and completed sessions are kept.') && act(() => api('POST', '/api/plan/generate', { scope: 'week' }), 'Rest of the week re-planned')],
      S.undo && [`Undo: ${S.undo.label}`, doUndo],
      ['Download calendar (.ics)', () => (location.href = '/api/plan.ics')],
    ]))];
  out.push(h('div', { class: 'tabs' },
    weeks.map((w, i) => h('button', { class: `btn ${i === planWeek ? 'primary' : ''} ${w.past ? 'pastweek' : ''}`, onclick: () => { planWeek = i; render(); } }, label(w, i),
      h('span', { class: 'small' }, w.past ? ' · done' : ` · ${PHASE[w.phase]}${w.recovery ? ' (R)' : ''}`)))));
  if (u && pending && !wk.past) out.push(h('div', { class: 'notice' }, u.never ? 'This plan has not been sent to Intervals.icu yet, so your devices do not have it.'
    : `${pending} session${pending === 1 ? '' : 's'} in the next two weeks ${pending === 1 ? 'differs' : 'differ'} from what is on your devices${u.removed ? ` (${u.removed} removed here)` : ''}. Push to update them.`));
  out.push(h('div', { class: 'week' }, DAYS.map((d, i) => {
    const date = addDays(wk.start, i);
    const list = S.sessions.filter((x) => x.date === date), extras = S.extras.filter((a) => a.date === date);
    const ov = S.availability.overrides[date];
    const cap = ov ? ov.minutes : S.availability.days[i].minutes;
    return h('div', { class: `day ${date === S.today ? 'today' : ''} ${date < S.today ? 'past' : ''}` },
      h('div', { class: 'dh' }, h('b', {}, `${d} ${+date.slice(8)}`), h('span', {}, ov ? `${ov.note || 'exception'} · ${hm(cap)}` : cap != null ? `max ${hm(cap)}` : '')),
      list.map(sessCard), extras.map(extraCard),
      !list.length && !extras.length && h('div', { class: 'muted small' }, cap != null && cap < 30 ? 'Unavailable' : 'Rest'));
  })));
  if (current) out.push(adaptCards());
  for (const w of S.weekWarnings[wk.start] || []) out.push(h('div', { class: 'notice' }, w, ' ', h('a', { href: '#availability' }, 'Availability')));
  const sports = Object.entries(wk.bySport).sort((a, b) => b[1] - a[1]);
  out.push(h('div', { class: 'grid g3', style: 'margin-top:14px' },
    card('Planned', h('div', { class: 'stat num' }, `${hm(wk.plannedMin)} · ${wk.plannedTss} TSS`), wk.targetTss != null && h('div', { class: 'muted small' }, `Target ${wk.targetHours} h · ${wk.targetTss} TSS`)),
    card('Completed', h('div', { class: 'stat num' }, `${hm(wk.doneMin)} · ${wk.doneTss} TSS`), h('div', { class: 'muted small' }, `Key sessions ${wk.keyDone}/${wk.keyTotal}`)),
    card('By discipline', sports.map(([sp, min]) => h('div', { class: `row ${sp}` }, h('span', { class: 'dot', style: 'background:var(--c)' }), h('span', {}, SPORT[sp]), h('span', { class: 'right num' }, hm(min)))))));
  if (wk.focus) out.push(h('p', { class: 'muted small' }, wk.focus));
  return out;
}
function addDialog(weekStart) {
  const date = h('input', { type: 'date', value: weekStart });
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
  const remove = (list, i) => h('button', { class: 'btn sm danger', onclick: () => { list.splice(i, 1); setDirty('races'); render(); } }, 'Remove');
  savers.races = () => act(async () => {
    await api('PUT', '/api/races', races);
    await api('PUT', '/api/goals', goals);
    if (S.season) await api('POST', '/api/plan/generate', {});
    discard('races');
  }, S.season ? 'Saved. Future weeks re-planned.' : 'Saved.');
  const saved = (r) => r.id && S.races.some((x) => x.id === r.id);
  return [
    page('Races & goals', 'A-races shape the whole season. B-races get a short freshen-up. C-races are trained through. Add past races too: their results calibrate your predictions.'),
    h('h2', {}, 'Races'),
    races.length ? races.map((r, i) => h('div', { class: `card item ${r.date < S.today ? 'pastitem' : ''}` },
      h('div', { class: 'form' }, field('Race', inp(r, 'name', { placeholder: 'Race name' })), field('Date', inp(r, 'date', { type: 'date' })), field('Type', sel(r, 'type', RACE_TYPES)),
        field('Priority', sel(r, 'priority', { A: 'A — peak for it', B: 'B — freshen up', C: 'C — train through' })), field('Goal', inp(r, 'goal', { placeholder: 'e.g. sub 4:30, AG podium' }))),
      h('div', { class: 'row', style: 'margin-top:10px' }, r.date < S.today && h('span', { class: 'pill' }, 'Past race'),
        saved(r) ? [h('button', { class: 'btn sm', onclick: () => courseDialog(r.id) }, r.course || r.podium ? 'Course & targets ✓' : 'Course & targets'),
          r.date < S.today && h('button', { class: 'btn sm primary', onclick: () => resultDialog(r.id) }, 'Result & analysis')] : h('span', { class: 'muted small' }, 'Save to add the course, targets or result.'),
        h('span', { class: 'right' }, remove(races, i))))) : h('p', { class: 'muted' }, 'No races yet.'),
    h('div', { class: 'row', style: 'margin-bottom:22px' }, btn('Add a race', () => { races.push({ name: '', date: addDays(S.today, 120), type: 'half', priority: 'A' }); setDirty('races'); render(); })),
    h('h2', {}, 'Goals'),
    h('p', { class: 'muted small' }, 'Performance, health, skill and life goals in one place. Season goals should serve the long-term ones — review them at every recovery week.'),
    goals.map((g, i) => h('div', { class: 'card item' },
      h('div', { class: 'form' }, field('Goal', inp(g, 'title', { placeholder: 'e.g. Top-3 age group at 70.3' })), field('Area', sel(g, 'category', { performance: 'Performance', health: 'Health', skill: 'Skill', life: 'Life balance' })),
        field('Horizon', sel(g, 'horizon', { season: 'This season', 'long-term': 'Long term' })), field('Measure / target', inp(g, 'target', { placeholder: 'e.g. FTP 4.3 W/kg' })), field('By', inp(g, 'due', { type: 'date' })),
        field('Status', sel(g, 'status', { active: 'Active', achieved: 'Achieved', parked: 'Parked' }))),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'right' }, remove(goals, i))))),
    h('div', { class: 'row' }, btn('Add a goal', () => { goals.push({ title: '', category: 'performance', horizon: 'season', status: 'active' }); setDirty('races'); render(); })),
  ];
}

// ---------------- Availability ----------------
// ---------------- Availability ----------------
// The plan lays out its best week first; limits and fixed days are constraints added on top.
let previewTimer = null;
function refreshPreview(now) {
  const run = async () => {
    const a = draft.availability, pv = draft.preview;
    if (!a || !pv) return;
    pv.loading = true;
    try { pv.data = await api('POST', '/api/availability/preview', { availability: a, week: pv.which }); pv.error = null; }
    catch (e) { pv.error = e.message; }
    pv.loading = false;
    if (view === 'availability') render();
  };
  clearTimeout(previewTimer);
  if (now) run(); else previewTimer = setTimeout(run, 250);
}
function vAvailability() {
  const a = draft.availability ??= structuredClone(S.availability);
  a.fixed ??= {};
  const ov = draft.overrides ??= Object.entries(a.overrides).map(([date, v]) => ({ date, ...v })).sort((x, y) => x.date.localeCompare(y.date));
  const pv = draft.preview ??= { which: 'next', data: null, loading: false };
  if (!pv.data && !pv.loading && !pv.error) refreshPreview(true);
  const changed = () => { setDirty('availability'); refreshPreview(); };
  savers.availability = () => {
    a.overrides = Object.fromEntries(ov.filter((o) => o.date).map((o) => [o.date, { minutes: +o.minutes || 0, note: o.note }]));
    return saveAndReplan('PUT', '/api/availability', a, 'Availability saved.').then(() => { discard('availability'); render(); });
  };
  const d = pv.data, limited = a.days.some((x) => x.minutes != null);
  const LIMITS = [['', 'No limit'], [0, 'Unavailable'], [30, '0:30'], [45, '0:45'], [60, '1:00'], [75, '1:15'], [90, '1:30'], [120, '2:00'], [150, '2:30'], [180, '3:00'], [240, '4:00'], [300, '5:00']];
  const chips = (label, hint, get, set, multi) => h('div', { class: 'fixrow' }, h('div', {}, h('b', {}, label), h('div', { class: 'muted small' }, hint)),
    h('div', { class: 'chips' }, DAYS.map((name, i) => { const on = multi ? (get() || []).includes(i) : get() === i;
      return h('button', { class: `chip ${on ? 'on' : ''}`, 'aria-pressed': on, onclick: () => {
        if (multi) { const cur = new Set(get() || []); cur.has(i) ? cur.delete(i) : cur.add(i); set([...cur].sort()); } else set(on ? undefined : i);
        changed(); render();
      } }, name); })));
  const fx = a.fixed;
  const delta = d && d.limited ? d.minutes - d.optimal.minutes : 0;
  return [
    page('Availability', 'This is the week the plan would give you with nothing in the way. Fix the days that are fixed, cap the days that are short, and see what it costs.'),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, limited ? 'Your week with your limits' : 'Your optimal week'),
        h('div', { class: 'row right', 'data-nodraft': '' }, [['next', 'A typical week now'], ['peak', 'The biggest week of the season']].map(([k, l]) =>
          h('button', { class: `btn sm ${pv.which === k ? 'primary' : ''}`, onclick: () => { pv.which = k; pv.data = null; render(); } }, l)))),
      !d ? h('p', { class: 'muted', style: 'margin-top:10px' }, pv.error || 'Working out your week…') : [
        h('p', { style: 'margin:10px 0' }, h('b', { class: 'num' }, `${hm(d.minutes)} · ${d.tss} TSS`), ` in ${d.sessions} sessions — ${PHASE[d.week.phase].toLowerCase()} week, target ${d.week.targetTss} TSS. `,
          d.limited ? (Math.abs(delta) < 10 && d.sessions === d.optimal.sessions ? h('span', { class: 'pill good' }, 'Your limits cost nothing')
            : h('span', { class: `pill ${delta < -45 || d.sessions < d.optimal.sessions ? 'warn' : ''}` }, `${delta <= 0 ? '−' : '+'}${hm(Math.abs(delta))} and ${d.optimal.sessions - d.sessions > 0 ? `${d.optimal.sessions - d.sessions} fewer session${d.optimal.sessions - d.sessions === 1 ? '' : 's'}` : 'the same sessions'} versus the optimal ${hm(d.optimal.minutes)}`))
            : h('span', { class: 'pill good' }, 'Nothing is constraining it')),
        h('div', { class: `week ${pv.loading ? 'loading' : ''}` }, d.days.map((day, i) => h('div', { class: 'day' },
          h('div', { class: 'dh' }, h('b', {}, DAYS[i]), h('span', { class: 'num' }, day.minutes ? hm(day.minutes) : '')),
          day.sessions.length ? day.sessions.map((x) => h('div', { class: `sess static ${x.sport}` }, h('div', { class: 't' }, x.name), h('div', { class: 'm' }, `${SPORT[x.sport]} · ${hm(x.minutes)}${x.hard ? ' · hard' : ''}`)))
            : h('div', { class: 'muted small' }, fx.rest === i ? 'Rest (fixed)' : a.days[i].minutes === 0 ? 'Unavailable' : 'Rest'),
          d.limited && d.optimal.days[i] - day.minutes >= 10 && h('div', { class: 'small lost' }, `optimal ${hm(d.optimal.days[i])}`),
          h('div', { class: 'daylimit' }, h('select', { 'aria-label': `${DAYS[i]} time limit`, onchange: (e) => { a.days[i].minutes = e.target.value === '' ? null : +e.target.value; changed(); } },
            LIMITS.map(([v, l]) => h('option', { value: v, selected: (a.days[i].minutes ?? '') === v }, l)),
            a.days[i].minutes != null && !LIMITS.some(([v]) => v === a.days[i].minutes) && h('option', { value: a.days[i].minutes, selected: true }, hm(a.days[i].minutes))),
            h('div', { class: 'chips small' },
              !fx.swim?.length && h('button', { class: `chip ${a.days[i].pool ? 'on' : ''}`, title: 'Pool available', onclick: () => { a.days[i].pool = !a.days[i].pool; changed(); render(); } }, 'Pool'),
              !fx.strength?.length && h('button', { class: `chip ${a.days[i].gym ? 'on' : ''}`, title: 'Gym available', onclick: () => { a.days[i].gym = !a.days[i].gym; changed(); render(); } }, 'Gym')))))),
        d.warnings.map((w) => h('div', { class: 'notice', style: 'margin-top:10px' }, w)),
        h('p', { class: 'muted small', style: 'margin-top:10px' }, 'Set a limit under a day only where you have to. Each change re-flows the week here straight away; nothing is saved until you press Save.'),
        limited && h('div', { 'data-nodraft': '' }, btn('Remove all limits', () => { for (const x of a.days) x.minutes = null; changed(); render(); }, 'sm')),
      ]),
    card('Fixed days',
      h('p', { class: 'muted small' }, 'Tap the days that are not negotiable. Leave a row empty and the plan chooses.'),
      chips('Swims', 'swim on exactly these days (squad, lane booking)', () => fx.swim, (v) => (fx.swim = v.length ? v : undefined), true),
      chips('Strength', 'lift only on these days', () => fx.strength, (v) => (fx.strength = v.length ? v : undefined), true),
      chips('Long ride', 'default: Saturday', () => fx.longRide, (v) => (fx.longRide = v)),
      chips('Long run', 'default: Sunday', () => fx.longRun, (v) => (fx.longRun = v)),
      chips('Rest day', S.profile.restDay ? 'default: Monday' : 'none protected unless you pick one', () => fx.rest, (v) => (fx.rest = v))),
    card('Exceptions (travel, work, family)',
      ov.length ? ov.map((o, i) => h('div', { class: 'form', style: 'margin-bottom:8px;align-items:end' },
        field('Date', h('input', { type: 'date', value: o.date, oninput: (e) => (o.date = e.target.value) })),
        field('Time available (min)', h('input', { type: 'number', min: 0, max: 600, step: 15, value: o.minutes, oninput: (e) => (o.minutes = +e.target.value || 0) })),
        field('Note', h('input', { value: o.note ?? '', placeholder: 'e.g. travel', oninput: (e) => (o.note = e.target.value) })),
        h('div', {}, h('button', { class: 'btn sm danger', onclick: () => { ov.splice(i, 1); setDirty('availability'); render(); } }, 'Remove')))) : h('p', { class: 'muted' }, 'None. Add one for a specific date that differs from your normal week.'),
      h('div', { class: 'row', style: 'margin-top:10px' }, btn('Add an exception', () => { ov.push({ date: addDays(S.today, 7), minutes: 0, note: '' }); setDirty('availability'); render(); }))),
  ];
}

// ---------------- Workouts ----------------
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
  const isNow = (b) => !!next && next.workout.name.includes(b.title);
  return [
    page('Strength programme', 'Periodised with the season: adaptation → maximal strength → power → in-season maintenance.'),
    next && h('div', { class: 'notice info' }, `Next strength session: ${next.workout.name} on ${fmtDate(next.date)}.`),
    ...S.strength.map((b) => h('details', { class: 'card fold', open: isNow(b) || (!next && b.block === 'adaptation') },
      h('summary', {}, h('h2', { style: 'display:inline;margin:0' }, b.title), isNow(b) && h('span', { class: 'pill good', style: 'margin-left:10px' }, 'Current block'), h('div', { class: 'muted small', style: 'margin-top:4px' }, b.dosing)),
      h('p', { style: 'margin-top:10px' }, b.aim),
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
// ---------------- Profile ----------------
function vProfile() {
  const p = draft.profile ??= structuredClone(S.profile);
  savers.profile = () => saveAndReplan('PUT', '/api/profile', p, 'Profile saved.').then(() => { discard('profile'); render(); });
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
      field('Progression rate', sel(p, 'ramp', { conservative: 'Conservative (~3 CTL/wk)', moderate: 'Moderate (~4 CTL/wk)', aggressive: 'Aggressive (~5 CTL/wk)', ...(S.insights.ramp ? { learned: `From my history (~${S.insights.ramp.suggested} CTL/wk)` } : {}) })),
      field('Recovery cycle', sel(p, 'recoveryCycle', { auto: 'Auto (by age)', '3:1': '3 weeks on, 1 easy', '2:1': '2 weeks on, 1 easy' })),
      field('Limiter (gets extra time)', sel(p, 'limiter', { none: 'Balanced', swim: 'Swim', bike: 'Bike', run: 'Run' })),
      field('Strength equipment', sel(p, 'strengthEquipment', { gym: 'Full gym (barbell)', home: 'Home (dumbbells, bands)' })),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: p.restDay, onchange: (e) => (p.restDay = e.target.checked) }), 'Protect one full rest day per week'),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: p.autoAdapt, onchange: (e) => (p.autoAdapt = e.target.checked) }), 'Apply suggested adjustments automatically after each sync')),
      S.ctl != null && h('p', { class: 'muted small', style: 'margin-top:10px' }, `Starting fitness is taken from Intervals.icu (CTL ${S.ctl.toFixed(0)}), not from the hours above.`)),
    card('Return to training', h('div', { class: 'form' },
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: p.comeback.active, onchange: (e) => (p.comeback.active = e.target.checked) }), 'I am coming back from a break'),
      field('Weeks off / heavily reduced', h('input', { type: 'number', min: 0, max: 104, value: p.comeback.weeksOff, oninput: (e) => (p.comeback.weeksOff = +e.target.value || 0) })),
      field('Resumed training on', h('input', { type: 'date', value: p.comeback.resumedOn ?? '', oninput: (e) => (p.comeback.resumedOn = e.target.value || null) })),
      field('Notes (private)', h('input', { value: p.comeback.note ?? '', oninput: (e) => (p.comeback.note = e.target.value) }))),
      h('p', { class: 'muted small', style: 'margin-top:10px' }, 'Sets the length of the rebuild block (2–6 weeks): aerobic volume and strength first, bike intensity from week 2, run intensity last. Weeks already served since you resumed are credited. Untick once you are through it.')),
    h('div', { class: 'row', style: 'margin-bottom:14px' }, btn('Save profile', () => savers.profile(), 'primary')),
    card('Your zones', h('div', { class: 'grid g3' }, zt('Bike', S.zones.bike), zt('Run', S.zones.run), zt('Swim', S.zones.swim))),
  ];
}

// ---------------- Connect ----------------
function vConnect() {
  const i = S.intervals;
  const key = h('input', { type: 'password', placeholder: 'API key', autocomplete: 'off', style: 'min-width:260px' });
  const id = h('input', { placeholder: 'Athlete ID, e.g. i123456 (optional)', value: i.athleteId ?? '' });
  const when = fmtWhen;
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

// ---------------- Course, targets, niggles, debrief, insights ----------------
const hms = (t) => (t == null ? '—' : `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(Math.round(t % 60)).padStart(2, '0')}`);
const parseHms = (v) => { const p = String(v || '').trim().split(':').map(Number); if (!p.length || p.some((n) => !Number.isFinite(n)) || !String(v).trim()) return null; return p.reduce((t, n) => t * 60 + n, 0) * (p.length === 1 ? 60 : 1); };
// Read a GPX file in the browser and reduce it to [lat, lon, ele] points for the server.
async function readGpx(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
  let nodes = [...doc.getElementsByTagName('trkpt')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
  const pts = nodes.map((n) => [parseFloat(n.getAttribute('lat')), parseFloat(n.getAttribute('lon')), parseFloat(n.getElementsByTagName('ele')[0]?.textContent)]).filter((p) => p.every(Number.isFinite));
  if (pts.length < 2) throw new Error('No track points with elevation found in that GPX file.');
  const stride = Math.ceil(pts.length / 8000);
  return pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
}
function elevationChart(leg, cls) {
  const W = 620, H = 120, pts = leg.profile, maxD = pts.at(-1)[0], lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]), lo + 50);
  const x = (d) => 30 + (d / maxD) * (W - 34), y = (e) => 6 + (H - 26) * (1 - (e - lo) / (hi - lo));
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:auto', role: 'img', 'aria-label': 'Elevation profile', class: cls });
  g.append(svg('polygon', { points: `${x(0)},${H - 20} ${pts.map((p) => `${x(p[0])},${y(p[1])}`).join(' ')} ${x(maxD)},${H - 20}`, fill: 'var(--c)', opacity: 0.35 }),
    svg('polyline', { points: pts.map((p) => `${x(p[0])},${y(p[1])}`).join(' '), fill: 'none', stroke: 'var(--c)', 'stroke-width': 1.5 }),
    svg('text', { x: 0, y: y(hi) + 8 }, `${hi} m`), svg('text', { x: 0, y: H - 22 }, `${lo} m`), svg('text', { x: 30, y: H - 4 }, '0'), svg('text', { x: W - 4, y: H - 4, 'text-anchor': 'end' }, `${maxD} km`));
  return g;
}
function courseDialog(id) {
  const r = S.races.find((x) => x.id === id);
  if (!r) return;
  const c = r.course || {}, a = r.analysis, pod = r.podium || {};
  const f = { cda: c.cda ?? '', bikeKg: c.bikeKg ?? '', tempC: c.tempC ?? '', transitionMin: c.transitionMin ?? '', wetsuit: !!c.wetsuit, swim: pod.swim ? hms(pod.swim) : '', bike: pod.bike ? hms(pod.bike) : '', run: pod.run ? hms(pod.run) : '', total: pod.total ? hms(pod.total) : '' };
  const inp = (key, attrs = {}) => h('input', { value: f[key], oninput: (e) => (f[key] = e.target.value), style: 'width:110px', ...attrs });
  const bikeFile = h('input', { type: 'file', accept: '.gpx' }), runFile = h('input', { type: 'file', accept: '.gpx' });
  const save = (extra = {}) => act(async () => {
    const body = { cda: f.cda, bikeKg: f.bikeKg, tempC: f.tempC, transitionMin: f.transitionMin, wetsuit: f.wetsuit,
      podium: { swim: parseHms(f.swim), bike: parseHms(f.bike), run: parseHms(f.run), total: parseHms(f.total) }, ...extra };
    if (bikeFile.files[0]) body.bikePoints = await readGpx(bikeFile.files[0]);
    if (runFile.files[0]) body.runPoints = await readGpx(runFile.files[0]);
    await api('PUT', `/api/races/${id}`, body);
    if (S.season) await api('POST', '/api/plan/generate', {});
  }, 'Course saved. Future weeks re-planned.').then(() => { delete draft.races; courseDialog(id); });
  const pr = a.prediction, bp = pr?.bike, gap = a.gap;
  const legRow = (leg, label, cls, clear) => leg && h('div', { class: cls, style: 'margin-bottom:12px' },
    h('div', { class: 'row' }, h('b', {}, `${label}: ${leg.km} km · ${leg.gain} m climbing · ${leg.climbs.length} climb${leg.climbs.length === 1 ? '' : 's'}`), h('button', { class: 'btn sm danger right', onclick: () => save({ [clear]: true }) }, 'Remove')),
    elevationChart(leg, cls));
  openDialog('race', `${r.name} — course & targets`, [
    h('h3', {}, 'Course'),
    legRow(c.bike, 'Bike', 'bike', 'clearBike'), legRow(c.run, 'Run', 'run', 'clearRun'),
    h('div', { class: 'form' }, field(c.bike ? 'Replace bike GPX' : 'Bike course GPX', bikeFile), field(c.run ? 'Replace run GPX' : 'Run course GPX', runFile)),
    h('div', { class: 'form', style: 'margin-top:10px' },
      field('Expected temperature (°C)', inp('tempC', { type: 'number' })), field('CdA in race position (m²)', inp('cda', { type: 'number', step: '0.01', placeholder: '0.27' })),
      field('Bike + kit weight (kg)', inp('bikeKg', { type: 'number', step: '0.1', placeholder: '9' })), field('Transitions, total (min)', inp('transitionMin', { type: 'number', step: '0.5' })),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: f.wetsuit, onchange: (e) => (f.wetsuit = e.target.checked) }), 'Wetsuit swim')),
    h('p', { class: 'muted small', style: 'margin-top:8px' }, 'CdA is the biggest unknown in the bike prediction: about 0.22–0.25 for a dialled TT position, 0.26–0.30 typical, 0.32+ on a road bike. If you know a past split on a known course, adjust it until the prediction matches.'),
    h('h3', { style: 'margin-top:14px' }, 'Target splits'),
    h('p', { class: 'muted small' }, 'The times that reach your goal — e.g. last year’s age-group podium at this race. Format h:mm:ss.'),
    h('div', { class: 'form' }, field('Swim', inp('swim', { placeholder: '0:29:30' })), field('Bike', inp('bike', { placeholder: '2:18:00' })), field('Run', inp('run', { placeholder: '1:24:00' })), field('Total', inp('total', { placeholder: '4:18:00' }))),
    h('div', { style: 'margin:12px 0' }, btn('Save', () => save(), 'primary')),
    pr && [h('h3', {}, 'Prediction on current thresholds'),
      S.raceModel && h('p', { class: 'muted small' }, `Calibrated from ${S.raceModel.sources.join(', ')}${S.raceModel.cda && !c.cda ? ` — CdA ${S.raceModel.cda}` : ''}${S.raceModel.fracs[r.type] ? ', with the intensities you actually held at this distance' : ''}.`),
      pr.missing.length ? h('div', { class: 'notice' }, `Missing: ${pr.missing.join(', ')} — set them in Profile for a full prediction.`) : null,
      h('table', {}, h('thead', {}, h('tr', {}, ['Leg', 'Distance', 'Predicted', 'Target', 'Gap', 'Basis'].map((x) => h('th', {}, x)))), h('tbody', {},
        pr.legs.map((l) => { const g = gap?.rows.find((q) => q.sport === l.sport && pr.legs.filter((z) => z.sport === l.sport).length === 1);
          return h('tr', {}, h('td', {}, h('b', {}, l.label)), h('td', { class: 'num' }, `${l.km} km`), h('td', { class: 'num' }, hms(l.secs)), h('td', { class: 'num' }, g ? hms(g.target) : ''),
            h('td', { class: 'num', style: g ? `color:var(--${g.gap > 0 ? 'bad' : 'good'})` : '' }, g ? `${g.gap > 0 ? '+' : '−'}${hms(Math.abs(g.gap)).replace(/^0:/, '')}` : ''), h('td', { class: 'small muted' }, l.note)); }),
        h('tr', {}, h('td', {}, h('b', {}, 'Total')), h('td', {}, pr.transitions ? h('span', { class: 'small muted' }, `incl. ${Math.round(pr.transitions / 60)} min transitions`) : ''), h('td', { class: 'num' }, h('b', {}, hms(pr.total))), h('td', { class: 'num' }, pod.total ? hms(pod.total) : ''),
          h('td', { class: 'num' }, gap?.totalGap != null ? `${gap.totalGap > 0 ? '+' : '−'}${hms(Math.abs(gap.totalGap)).replace(/^0:/, '')}` : ''), h('td', {}, '')))),
      gap && h('div', { class: 'notice info', style: 'margin-top:10px' }, gap.text, gap.focus && S.profile.limiter !== gap.focus
        ? h('div', { style: 'margin-top:8px' }, btn(`Give the ${gap.focus} extra training time`, () => act(async () => { await api('PUT', '/api/profile', { ...S.profile, limiter: gap.focus }); if (S.season) await api('POST', '/api/plan/generate', {}); }, `Limiter set to ${gap.focus}. Future weeks re-planned.`).then(() => courseDialog(id)), 'sm primary'))
        : gap.focus ? h('div', { class: 'small', style: 'margin-top:6px' }, `Your plan already gives the ${gap.focus} extra time.`) : null)],
    bp && c.bike && [h('h3', { style: 'margin-top:14px' }, 'Bike pacing plan'),
      h('p', {}, `Hold normalised power at ${bp.np} W: about ${bp.flatWatts} W on the flat, more on the climbs, less on the descents. Average ${bp.avgWatts} W, ${bp.kph} km/h, ${bp.kj} kJ — roughly ${Math.round(bp.secs / 3600 * 80 / 5) * 5}–${Math.round(bp.secs / 3600 * 100 / 5) * 5} g carbohydrate on the bike.`),
      bp.climbs.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Climb at', 'Length', 'Gain', 'Grade', 'Power', 'Time'].map((x) => h('th', {}, x)))), h('tbody', {},
        bp.climbs.map((cl) => h('tr', {}, h('td', { class: 'num' }, `${cl.startKm} km`), h('td', { class: 'num' }, `${cl.km} km`), h('td', { class: 'num' }, `${cl.gain} m`), h('td', { class: 'num' }, `${cl.grade}%`), h('td', { class: 'num' }, h('b', {}, `${cl.watts} W`)), h('td', { class: 'num' }, `${cl.min} min`))))) : null],
    a.demands && h('div', { class: 'notice good', style: 'margin-top:12px' }, h('b', {}, 'How this shapes your training: '),
      [a.demands.climbMin.length && a.demands.terrain !== 'flat' ? `the race-pace bike session in the specific block becomes reps of about ${Math.round([...a.demands.climbMin].sort((x, y) => x - y)[a.demands.climbMin.length >> 1])} min at ${Math.round(a.demands.climbFrac * 100)}% FTP, matching the course’s climbs` : a.demands.terrain === 'rolling' ? 'the race-pace bike session becomes surge-and-settle work for rolling terrain' : 'steady race-power work for a flat course',
        a.demands.runHilly && 'hill reps alternate with the key run', a.demands.hot && 'easy sessions in the last three weeks carry heat-acclimation instructions'].filter(Boolean).join('; ') + '.'),
  ]);
}
// A race already run: actual splits against the model, and what it says about how you race.
function resultDialog(id) {
  const r = S.races.find((x) => x.id === id);
  const a = r?.result_analysis;
  if (!r || !a) return;
  const res = r.result || {};
  const f = { manual: Object.fromEntries(a.legs.map((l) => [l.label, res.manual?.[l.label] ? hms(res.manual[l.label]) : ''])), total: res.manual?.Total ? hms(res.manual.Total) : '',
    ftp: res.then?.ftp ?? '', run: res.then?.runPaceSecPerKm ? clock(res.then.runPaceSecPerKm) : '', css: res.then?.cssSecPer100 ? clock(res.then.cssSecPer100) : '', use: res.use !== false };
  const save = () => act(async () => {
    const manual = Object.fromEntries(Object.entries(f.manual).map(([k, v]) => [k, parseHms(v)]).filter(([, v]) => v));
    if (parseHms(f.total)) manual.Total = parseHms(f.total);
    await api('PUT', `/api/races/${id}`, { result: { manual, then: { ftp: f.ftp, runPaceSecPerKm: parseClock(f.run), cssSecPer100: parseClock(f.css) }, use: f.use } });
    if (S.season) await api('POST', '/api/plan/generate', {});
  }, 'Result saved.').then(() => { delete draft.races; resultDialog(id); });
  const diff = (act, mod) => (act && mod ? h('span', { style: `color:var(--${act <= mod ? 'good' : 'bad'})` }, `${act <= mod ? '−' : '+'}${hms(Math.abs(act - mod)).replace(/^0:/, '')}`) : '');
  const any = a.legs.some((l) => l.secs);
  openDialog('race', `${r.name} — result`, [
    h('div', { class: 'row', style: 'margin-bottom:10px' }, h('span', { class: 'pill' }, fmtDate(r.date, true)), h('span', { class: 'pill' }, RACE_TYPES[r.type]),
      a.total && h('span', { class: 'pill good' }, `Finished ${hms(a.total)}`), a.usable && h('span', { class: 'pill good' }, 'Calibrating predictions')),
    !any && h('div', { class: 'notice' }, `No swim, bike or run activities were found on ${fmtDate(r.date, true)}. Check the race date, re-import your history under Connect, or type the splits in below.`),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Leg', 'Actual', 'Model', 'vs model', 'You held', 'Assumed', 'From'].map((x) => h('th', {}, x)))), h('tbody', {},
      a.legs.map((l) => h('tr', {}, h('td', {}, h('b', {}, l.label), h('div', { class: 'muted small' }, `${l.km} km`)), h('td', { class: 'num' }, h('b', {}, hms(l.secs))), h('td', { class: 'num' }, hms(l.modelled)), h('td', { class: 'num' }, diff(l.secs, l.modelled)),
        h('td', { class: 'num' }, l.frac ? h('b', {}, `${Math.round(l.frac * 100)}%`) : '—'), h('td', { class: 'num muted' }, `${Math.round(l.defaultFrac * 100)}%`),
        h('td', { class: 'small' }, l.source === 'activity' ? l.activity : l.source === 'manual' ? 'entered by you' : h('span', { class: 'muted' }, 'missing'), h('div', { class: 'muted' }, l.note)))),
      h('tr', {}, h('td', {}, h('b', {}, 'Total')), h('td', { class: 'num' }, h('b', {}, hms(a.total))), h('td', { class: 'num' }, hms(a.modelledTotal)), h('td', { class: 'num' }, diff(a.total, a.modelledTotal)), h('td', {}, ''), h('td', {}, ''), h('td', {}, ''))))),
    h('p', { class: 'muted small', style: 'margin-top:6px' }, `“Model” is what the generic assumptions predict with the thresholds you held then (${a.then.source}). “You held” is the share of threshold you actually raced each leg at; “Assumed” is the generic figure it replaces.`),
    a.cda != null && h('div', { class: 'notice info' }, h('b', {}, `Effective CdA ${a.cda}`), ` — the drag area at which your recorded power gives your actual bike split on this course${r.course?.bike ? '' : ' (flat course assumed)'}.`),
    a.notes.map((n) => h('div', { class: 'notice' }, n)),
    a.today && a.total && h('div', { class: 'notice good' }, h('b', {}, `The same race today: ${hms(a.today)}`), ` — ${a.today <= a.total ? `${hms(a.total - a.today).replace(/^0:/, '')} faster` : `${hms(a.today - a.total).replace(/^0:/, '')} slower`} than you went, on current thresholds and the way you actually race.`),
    h('h3', { style: 'margin-top:14px' }, 'Correct the splits'),
    h('p', { class: 'muted small' }, 'Leave blank to use the recorded activity. Format h:mm:ss. Official results usually beat watch splits when transitions were recorded inside a leg.'),
    h('div', { class: 'form' }, a.legs.map((l) => field(l.label, h('input', { value: f.manual[l.label], placeholder: l.secs ? hms(l.secs) : '0:00:00', oninput: (e) => (f.manual[l.label] = e.target.value) }))),
      field('Official total', h('input', { value: f.total, placeholder: a.total ? hms(a.total) : '0:00:00', oninput: (e) => (f.total = e.target.value) }))),
    h('h3', { style: 'margin-top:14px' }, 'Your thresholds at the time'),
    h('div', { class: 'form' }, field('FTP (W)', h('input', { type: 'number', value: f.ftp, placeholder: a.then.ftp ?? '', oninput: (e) => (f.ftp = e.target.value) })),
      field('Run threshold pace (min:ss /km)', h('input', { value: f.run, placeholder: a.then.runPaceSecPerKm ? clock(a.then.runPaceSecPerKm) : '', onchange: (e) => (f.run = e.target.value) })),
      field('CSS (min:ss /100 m)', h('input', { value: f.css, placeholder: a.then.cssSecPer100 ? clock(a.then.cssSecPer100) : '', onchange: (e) => (f.css = e.target.value) })),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: f.use, onchange: (e) => (f.use = e.target.checked) }), 'Use this race to calibrate predictions')),
    h('p', { class: 'muted small', style: 'margin-top:6px' }, 'The intensities only mean something against the thresholds you held on race day. If your run threshold or CSS was different then, enter it.'),
    h('div', { class: 'row', style: 'margin-top:12px' }, btn('Save', save, 'primary'), btn(r.course?.bike ? 'Edit course' : 'Add the course GPX', () => courseDialog(id))),
  ]);
}
function raceBaselines() {
  const past = S.races.filter((r) => r.past && r.result_analysis?.legs.some((l) => l.secs)).sort((a, b) => b.date.localeCompare(a.date));
  const m = S.raceModel;
  return card('Race baselines',
    past.length ? [
      m && h('p', {}, h('b', {}, 'How you race: '), [m.cda && `effective CdA ${m.cda}`, ...Object.entries(m.fracs).map(([t, fr]) => `${RACE_TYPES[t]}: ${Object.entries(fr).map(([l, v]) => `${l.toLowerCase()} ${Math.round(v * 100)}%`).join(', ')} of threshold`)].filter(Boolean).join(' · '), '. Future predictions and pacing plans use these.'),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Race', 'Splits', 'Finish', 'Same race today', ''].map((x) => h('th', {}, x)))), h('tbody', {}, past.map((r) => { const a = r.result_analysis;
        return h('tr', {}, h('td', {}, h('b', {}, r.name), h('div', { class: 'muted small' }, `${fmtDate(r.date, true)} · ${RACE_TYPES[r.type]}`)),
          h('td', { class: 'small num' }, a.legs.map((l) => `${l.label} ${hms(l.secs)}${l.frac ? ` (${Math.round(l.frac * 100)}%)` : ''}`).join(' · ')), h('td', { class: 'num' }, h('b', {}, hms(a.total))),
          h('td', { class: 'num' }, a.today ? [hms(a.today), a.total ? h('div', { class: 'small', style: `color:var(--${a.today <= a.total ? 'good' : 'bad'})` }, `${a.today <= a.total ? '−' : '+'}${hms(Math.abs(a.today - a.total)).replace(/^0:/, '')}`) : null] : '—'),
          h('td', {}, h('button', { class: 'btn sm', onclick: () => resultDialog(r.id) }, 'Open'))); })))),
      !m && h('p', { class: 'muted small', style: 'margin-top:8px' }, 'None of these is calibrating predictions yet: open one to check its splits and thresholds.'),
    ] : h('p', { class: 'muted' }, 'Add a race you have already done under Races & goals (with its real date). If its activities are in your imported history, the app works out the splits, how hard you actually raced each leg and your CdA, and uses them for every future prediction.'));
}
function niggleCard() {
  const list = S.niggles || [];
  const f = draft.niggle ??= { area: '', sport: 'run', severity: 1 };
  return card('Niggles',
    list.length ? list.map((n) => h('div', { class: 'signal' }, h('span', { class: `pill ${n.severity === 3 ? 'bad' : n.severity === 2 ? 'warn' : ''}` }, `${n.severity}/3`),
      h('div', { style: 'flex:1' }, h('b', {}, n.area), h('div', { class: 'muted small' }, `Affects ${n.sport} · since ${fmtDate(n.date)}${n.note ? ` · ${n.note}` : ''}`)),
      h('select', { onchange: (e) => act(() => api('PATCH', `/api/niggles/${n.id}`, { severity: +e.target.value }), 'Updated') }, [1, 2, 3].map((v) => h('option', { value: v, selected: n.severity === v }, `${v}`))),
      h('button', { class: 'btn sm', onclick: () => act(() => api('PATCH', `/api/niggles/${n.id}`, { resolved: true }), 'Marked as resolved') }, 'Resolved')))
      : h('p', { class: 'muted small' }, 'Nothing logged. Log anything that hurts or changes how you move; the plan pulls intensity or swaps sessions before it becomes an injury.'),
    h('details', {}, h('summary', {}, 'Log a niggle'),
      h('div', { class: 'form', style: 'margin-top:10px' },
        field('Where', h('input', { value: f.area, placeholder: 'e.g. left Achilles', oninput: (e) => (f.area = e.target.value) })),
        field('Affects', h('select', { onchange: (e) => (f.sport = e.target.value) }, ['run', 'bike', 'swim'].map((v) => h('option', { value: v, selected: f.sport === v }, SPORT[v])))),
        field('Severity', h('select', { onchange: (e) => (f.severity = +e.target.value) }, [[1, '1 · aware of it'], [2, '2 · alters how I move'], [3, '3 · painful']].map(([v, l]) => h('option', { value: v, selected: f.severity === v }, l))))),
      h('div', { style: 'margin-top:10px' }, btn('Log it', () => act(() => api('POST', '/api/niggles', f), 'Logged').then(() => delete draft.niggle)))));
}
let debriefing = false;
async function runDebrief() {
  if (debriefing) return;
  debriefing = true; render();
  try { await api('POST', '/api/coach/debrief', {}); } catch (e) { toast(e.message, true); }
  debriefing = false; await load();
}
function debriefCard() {
  if (!S.coach.configured || !S.season) return null;
  const d = S.debrief;
  const stale = !d || d.week !== S.season.weeks[0].start;
  return card('Weekly debrief',
    d ? h('details', { open: !stale }, h('summary', { class: 'muted small' }, `Written ${fmtDate(d.at.slice(0, 10))}${stale ? ' — for a previous week' : ''}`), h('div', { class: 'msg assistant', style: 'max-width:100%;margin-top:8px' }, rich(d.text)))
      : h('p', { class: 'muted small' }, 'A written review of your last 7 days against the plan, with what to change next. Uses the coach.'),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: `btn ${stale ? 'primary' : ''} ${debriefing ? 'busy' : ''}`, disabled: debriefing, onclick: runDebrief }, debriefing ? 'Writing…' : d ? 'Write a new one' : 'Write my debrief'),
      d && btn('Discuss with coach', () => go('coach'))));
}
// ---------------- Progress overview ----------------
function vOverview() {
  const O = S.overview, F = O.fitness, R = O.rebuild, L = O.levels;
  const out = [page('Progress overview', 'The evidence behind your plan: where your fitness is against what the plan assumed, how far through the rebuild you are, which workout types have moved up or down, and what your thresholds are doing.')];
  if (L.pending.length) out.push(h('div', { class: 'notice' }, h('b', {}, 'Progression has changed since the plan was built: '), `${L.pending.join(', ')}. Upcoming sessions of those types still use the old levels until the plan is regenerated (it happens automatically each Monday).`,
    h('div', { style: 'margin-top:8px' }, btn('Re-plan future weeks now', () => act(() => api('POST', '/api/plan/generate', {}), 'Future weeks re-planned with your current progression'), 'primary'))));

  // --- fitness against plan ---
  const W = 960, H = 230, padL = 36, padB = 26, padT = 12;
  const pts = F.weeks, n = Math.max(1, pts.length - 1);
  const vals = pts.flatMap((w) => [w.planned, w.actual]).filter((v) => v != null);
  const max = Math.max(20, ...vals) * 1.1, x = (i) => padL + (i / n) * (W - padL - 8), y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:auto', role: 'img', 'aria-label': 'Fitness against the plan' });
  for (const t of [0.5, 1]) { const v = Math.round((max / 1.1) * t / 10) * 10; g.append(svg('line', { x1: padL, x2: W, y1: y(v), y2: y(v), stroke: 'var(--line)' }), svg('text', { x: 2, y: y(v) + 4 }, v)); }
  const line = (key, filter, attrs) => { const seg = pts.map((w, i) => (filter(w) && w[key] != null ? `${x(i)},${y(w[key])}` : null)).filter(Boolean); if (seg.length > 1) g.append(svg('polyline', { fill: 'none', 'stroke-width': 2.5, points: seg.join(' '), ...attrs })); };
  const todayIdx = pts.findIndex((w) => w.future);
  if (todayIdx > 0) g.append(svg('line', { x1: x(todayIdx - 0.5), x2: x(todayIdx - 0.5), y1: padT, y2: H - padB, stroke: 'var(--muted)', 'stroke-dasharray': '2 4' }), svg('text', { x: x(todayIdx - 0.5) + 4, y: padT + 10 }, 'now'));
  line('planned', (w) => !w.future, { stroke: 'var(--accent)', 'stroke-dasharray': '6 4' });
  line('planned', (w) => w.future || w.start === pts[todayIdx - 1]?.start, { stroke: 'var(--accent)', opacity: 0.45, 'stroke-dasharray': '2 4' });
  line('actual', (w) => !w.future, { stroke: 'var(--text)' });
  pts.forEach((w, i) => { if (+w.start.slice(8) <= 7) g.append(svg('text', { x: x(i), y: H - 8 }, MONTHS[+w.start.slice(5, 7) - 1])); });
  out.push(card('Fitness against the plan',
    h('p', {}, F.text), g,
    h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--text);height:3px' }), 'Your fitness (CTL)'), h('span', {}, h('i', { style: 'background:var(--accent);height:3px' }), 'What the plan assumed'), h('span', {}, h('i', { style: 'background:var(--accent);opacity:.45;height:3px' }), 'Projection from here')),
    F.now != null && h('p', { class: 'muted small', style: 'margin-top:6px' }, `Fitness now: ${F.now}.`)));

  // --- rebuild block ---
  if (R) out.push(card('Return-to-training block',
    R.total ? [
      h('div', { class: 'row', style: 'margin-bottom:10px' }, R.weeks.map((w) => h('div', { class: `rbweek ${w.state}`, title: w.start ? `Week of ${fmtDate(w.start)}${w.targetTss ? ` · ${w.doneTss} of ${w.targetTss} TSS` : ` · ${w.doneTss} TSS`}` : '' },
        h('b', {}, `Week ${w.n}`), h('div', { class: 'small' }, w.state === 'done' ? (w.targetTss ? `${Math.round((w.doneTss / w.targetTss) * 100)}% of plan` : `${hm(w.doneHours * 60)}`) : w.state === 'current' ? 'this week' : 'to come')))),
      h('p', {}, R.done ? 'The block is complete: intensity and normal progression are in play.' : `Week ${Math.min(R.served + 1, R.total)} of ${R.total}. Frequency first, then volume, then intensity — run intensity last.`),
      R.checks.map((c) => h('div', { class: 'signal' }, h('span', { class: `pill ${c.ok ? 'good' : ''}` }, c.ok ? '✓' : '○'), h('div', {}, h('b', {}, c.label), h('div', { class: 'muted small' }, c.detail)))),
      h('p', { class: 'muted small', style: 'margin-top:8px' }, R.from ? `Counted from ${fmtDate(R.from, true)}. If that is wrong, set “Resumed training on” under Profile.` : R.note),
    ] : h('p', { class: 'muted' }, R.note)));

  // --- workout-type levels ---
  const phrase = (o) => (o === 0 ? 'on the calendar' : `${Math.abs(o)} level${Math.abs(o) === 1 ? '' : 's'} ${o > 0 ? 'ahead' : 'back'}`);
  out.push(card('Where each workout type stands',
    h('p', { class: 'muted small' }, 'After a key session is graded rep by rep: beat the targets with every rep done and the next session of that type skips a level; miss them and it steps back (at most two either way).'),
    L.ungraded > 0 && h('div', { class: 'notice info' }, `${L.ungraded} of ${L.hardDone} hard sessions in the last three weeks could not be graded rep by rep. Intervals.icu needs laps or detected intervals in the activity; open the session and press Re-grade once they exist.`),
    L.rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Workout type', 'Level', 'Next session', 'Recent sessions'].map((c) => h('th', {}, c)))), h('tbody', {}, L.rows.map((r) => h('tr', {},
      h('td', {}, h('b', {}, r.label)),
      h('td', {}, h('span', { class: `pill ${r.offset > 0 ? 'good' : r.offset < 0 ? 'warn' : ''}` }, phrase(r.offset)), r.offset !== r.planned && h('div', { class: 'small muted' }, 'not in the plan yet')),
      h('td', { class: 'small' }, r.next ? [h('div', {}, r.next.name), h('div', { class: 'muted' }, fmtDate(r.next.date))] : h('span', { class: 'muted' }, 'none planned')),
      h('td', { class: 'small' }, r.history.length ? h('details', {}, h('summary', {}, `${r.history.length} graded`), r.history.map((e) => h('div', { style: 'margin:6px 0' }, h('b', {}, `${fmtDate(e.date)} · ${e.name}`), e.delta ? h('span', { class: `pill ${e.delta > 0 ? 'good' : 'warn'}`, style: 'margin-left:6px' }, e.delta > 0 ? '+1' : '−1') : null, h('div', { class: 'muted' }, e.text)))) : h('span', { class: 'muted' }, '—')))))))
      : h('p', { class: 'muted' }, L.graded ? 'Sessions have been graded, but none has moved a level yet — each is still on the calendar’s level.' : 'Nothing graded yet. Key sessions are graded after each sync; none has been matched with intervals so far.')));

  // --- thresholds ---
  const fmtT = (t, v) => (v == null ? '—' : t.unit === 'pace' ? `${clock(v)}${t.key === 'cssSecPer100' ? '/100m' : '/km'}` : `${Math.round(v)} ${t.unit}`);
  const spark = (t) => { if (t.points.length < 2) return h('span', { class: 'muted small' }, 'no change recorded'); const a = t.points, vs = a.map((p) => p.value), lo = Math.min(...vs), hi = Math.max(...vs, lo + 1), t0 = toDate(a[0].date).getTime(), t1 = Math.max(toDate(a.at(-1).date).getTime(), t0 + 864e5);
    // Pace improves downwards; flip the axis so up always means better.
    const yy = (v) => 4 + 28 * (t.unit === 'pace' ? (v - lo) / (hi - lo) : 1 - (v - lo) / (hi - lo)), xx = (d) => 2 + ((toDate(d).getTime() - t0) / (t1 - t0)) * 116;
    const e = svg('svg', { viewBox: '0 0 120 36', width: 120, height: 36, role: 'img', 'aria-label': `${t.label} over time` });
    e.append(svg('polyline', { fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, points: a.map((p) => `${xx(p.date)},${yy(p.value)}`).join(' ') })); return e; };
  out.push(card('Thresholds',
    h('p', { class: 'muted small' }, 'Every target in the plan is a fraction of these. Bike FTP has a history from your activities; the others are recorded from the first time they were set here, so their trend fills in as they change.'),
    O.thresholds.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'Now', 'Three months ago', 'Change', 'Trend'].map((c) => h('th', {}, c)))), h('tbody', {}, O.thresholds.map((t) => {
      const better = t.changePct == null ? null : t.unit === 'pace' ? t.changePct < 0 : t.changePct > 0;
      return h('tr', {}, h('td', {}, h('b', {}, t.label)), h('td', { class: 'num' }, fmtT(t, t.current)), h('td', { class: 'num' }, fmtT(t, t.before)),
        h('td', { class: 'num' }, t.changePct == null || t.changePct === 0 ? h('span', { class: 'muted' }, '—') : h('span', { style: `color:var(--${better ? 'good' : 'warn'})` }, `${t.changePct > 0 ? '+' : ''}${t.changePct}%`)), h('td', {}, spark(t)));
    })))) : h('p', { class: 'muted' }, 'No thresholds set yet. Add them under Profile or sync from Intervals.icu.')));
  return out;
}

function vInsights() {
  const I = S.insights, out = [page('Insights', 'What your own data says: against your pre-break self, your target, and your history.')];
  const aRace = S.races.filter((r) => r.priority === 'A' && r.date >= S.today).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (aRace) {
    const pr = aRace.analysis.prediction, gap = aRace.analysis.gap;
    out.push(card(`${aRace.name} — where you stand`,
      pr?.total ? h('div', { class: 'row' }, h('div', {}, h('div', { class: 'label' }, 'Predicted today'), h('div', { class: 'stat num' }, hms(pr.total))),
        aRace.podium?.total && h('div', {}, h('div', { class: 'label' }, 'Target'), h('div', { class: 'stat num' }, hms(aRace.podium.total))),
        h('div', { class: 'muted small' }, pr.legs.map((l) => `${l.label} ${hms(l.secs)}`).join(' · '))) : h('p', { class: 'muted' }, pr ? `Set ${pr.missing.join(', ')} in Profile for a prediction.` : 'No prediction for this race type.'),
      gap ? h('p', { style: 'margin-top:10px' }, gap.text) : h('p', { class: 'muted small', style: 'margin-top:10px' }, 'Add target splits to see which discipline is worth the most training time.'),
      h('div', { style: 'margin-top:8px' }, btn(aRace.course || aRace.podium ? 'Open course & targets' : 'Add course & target splits', () => courseDialog(aRace.id), 'primary'))));
  } else out.push(card('Race prediction', h('p', { class: 'muted' }, 'Add an A-race to see predicted splits, the gap to your target and course-specific training.')));
  out.push(raceBaselines());
  const cb = I.comeback;
  out.push(card('Against your pre-break self', cb ? [
    h('p', { class: 'muted small' }, `Break ${fmtDate(cb.window.start, true)} – ${fmtDate(cb.window.end, true)} (${cb.window.source === 'profile' ? 'from your profile' : 'detected from your training history — set the dates in Profile if this is wrong'}). “Before” is your best in the 12 months leading into it.`),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'Before', 'Since return', ''].map((x) => h('th', {}, x)))), h('tbody', {}, cb.rows.map((r) => h('tr', {}, h('td', {}, r.label), h('td', { class: 'num' }, r.before), h('td', { class: 'num' }, r.now),
      h('td', { style: 'width:38%' }, r.pct == null ? h('span', { class: 'muted small' }, 'not yet done') : h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('div', { style: 'flex:1;height:8px;background:var(--panel2);border-radius:4px;overflow:hidden' }, h('div', { style: `width:${Math.min(100, r.pct)}%;height:100%;background:var(--${r.pct >= 97 ? 'good' : 'accent'})` })), h('span', { class: 'num small', style: 'width:42px;text-align:right' }, `${r.pct}%`)))))))),
    cb.regain && h('p', { style: 'margin-top:10px' }, cb.regain.date ? `On the current plan your fitness is back to 95% of the pre-break peak in the week ending ${fmtDate(cb.regain.date, true)}.` : `The current plan peaks at ${cb.regain.peakPct}% of your pre-break fitness; more weekly time would be needed to regain it fully this season.`),
    h('p', { class: 'muted small' }, 'Power and pace rows compare whole-session averages (normalised power, distance ÷ time), not peak efforts inside a session.'),
  ] : h('p', { class: 'muted' }, 'No lay-off found in your imported history. Set the weeks off and the date you resumed in Profile to track your return.')));
  const lr = I.ramp;
  out.push(card('Your sustainable progression', lr ? [
    h('div', { class: 'row' }, h('div', { class: 'stat num' }, `${lr.suggested}`), h('span', { class: 'muted' }, 'CTL points per week')),
    h('p', { style: 'margin-top:8px' }, lr.text),
    h('p', { class: 'muted small' }, 'A sharp drop in training looks the same in the data whether it was illness, injury or life, so treat this as a guide. It can drive the plan: choose “From my history” as the progression rate in Profile.'),
    S.profile.ramp === 'learned' ? h('span', { class: 'pill good' }, 'In use') : btn('Use this rate for my plan', () => act(async () => { await api('PUT', '/api/profile', { ...S.profile, ramp: 'learned' }); if (S.season) await api('POST', '/api/plan/generate', {}); }, 'Progression rate set from your history. Future weeks re-planned.')),
  ] : h('p', { class: 'muted' }, 'Needs at least six months of fitness history with a few sustained build blocks. Import your history under Connect.')));
  const prog = Object.entries(I.progress).filter(([, v]) => v);
  out.push(card('Progression earned from execution',
    prog.length ? h('table', {}, h('tbody', {}, prog.map(([k, v]) => h('tr', {}, h('td', {}, k.replace('.', ' · ')), h('td', {}, h('span', { class: `pill ${v > 0 ? 'good' : 'warn'}` }, `${v > 0 ? '+' : ''}${v} level${Math.abs(v) === 1 ? '' : 's'}`)), h('td', { class: 'small muted' }, v > 0 ? 'You beat the targets with every rep done; the next one of these skips ahead.' : 'Reps were missed or below target; the next one repeats an easier level.')))))
      : h('p', { class: 'muted' }, 'Key sessions are graded rep by rep after each sync. Beat the targets and the next session of that type moves up a level; miss them and it steps back. Nothing has moved yet.')));
  return out;
}

// ---------------- Coach ----------------
const coach = { pending: null, changes: [], input: '' };
function askCoach(text) { coach.input = text; go('coach'); }
async function sendCoach() {
  const text = coach.input.trim();
  if (!text || coach.pending) return;
  coach.pending = text; coach.input = ''; coach.changes = []; coach.partial = '';
  render();
  const before = S.undo?.at;
  try {
    // The reply arrives as server-sent events: text as it is written, then the outcome.
    const res = await fetch('/api/coach/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!line.startsWith('data: ')) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'text') {
          coach.partial += ev.text;
          const el = $('#coach-live');
          if (el) { el.classList.remove('muted'); el.replaceChildren(...rich(coach.partial)); el.parentElement.scrollTop = el.parentElement.scrollHeight; }
        } else if (ev.type === 'done') coach.changes = ev.changes;
        else if (ev.type === 'error') throw new Error(ev.error);
      }
    }
  } catch (e) { toast(e.message, true); if (!coach.partial) coach.input = text; }
  coach.pending = null; coach.partial = '';
  await load();
  if (coach.changes.length && S.undo && S.undo.at !== before) toast('The coach changed your plan.', false, { label: 'Undo', run: doUndo });
}
function vCoach() {
  if (!S.coach.configured) return [page('Coach', 'Talk through your plan with Claude.'), card(null, h('p', {}, 'Add an Anthropic API key to switch the coach on.'), btn('Set up under Connect', () => go('connect'), 'primary'))];
  const msgs = [...S.coach.messages, ...(coach.pending ? [{ role: 'user', text: coach.pending }] : [])];
  const ta = h('textarea', { placeholder: 'Ask about the plan, a session, or tell the coach what to change…', value: coach.input, rows: 3,
    oninput: (e) => (coach.input = e.target.value), onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCoach(); } } });
  const ideas = ['Why is this week structured the way it is?', 'I only have 45 minutes tomorrow — adjust the session.', 'Make Saturday’s long ride harder; I feel good.',
    'Compare my last 8 weeks with my best block. Am I ramping too fast?', 'I’m travelling Thursday and Friday next week with no bike. Re-plan around it.'];
  const log = h('div', { class: 'chat' },
    msgs.length ? msgs.map((m) => h('div', { class: `msg ${m.role}` }, m.role === 'assistant' ? rich(m.text) : m.text)) : h('div', { class: 'muted' }, 'The coach sees your profile, season, the next two weeks, recent training and today’s readiness, and can look up the rest. It can move, change, add or skip sessions when you ask.'),
    coach.pending && h('div', { class: 'msg assistant muted', id: 'coach-live' }, 'Thinking…'),
    !coach.pending && coach.changes.length ? h('div', { class: 'notice good' }, h('b', {}, 'Plan changed: '), coach.changes.join(' '), ' ', h('a', { href: '#plan' }, 'View plan'), S.intervals.connected ? ' — push from there to update your devices. ' : ' ', S.undo && h('button', { class: 'btn sm', onclick: doUndo }, 'Undo')) : null);
  setTimeout(() => { log.scrollTop = log.scrollHeight; if (!coach.pending) ta.focus(); });
  return [
    page('Coach', `Claude (${S.coach.model}) with access to your plan and history.`,
      btn('Weekly debrief', runDebrief), S.coach.messages.length ? btn('New conversation', () => confirm('Clear this conversation?') && act(() => api('DELETE', '/api/coach'), 'Conversation cleared').then(() => (coach.changes = []))) : null),
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
