# Triathlon Coach

A personal, adaptive triathlon training platform. It plans a whole season around your races, builds
each week from your real availability, prescribes every session by power (bike **and** run), pace or
heart rate, adapts day to day from your recovery data, and pushes structured workouts to
[Intervals.icu](https://intervals.icu) — and from there to your watch, head unit and trainer apps.

It is written for a trained athlete. No "walk/jog" scaffolding: intensity is real, load is driven by
your actual fitness, and the only conservative element is a deliberate return-to-training block
after time off.

## Run it

Requires Node.js ≥ 22.18.

```bash
npm install          # one dependency: the Anthropic SDK, for the AI coach
npm start            # http://127.0.0.1:3000
npm test             # engine + API tests (fake Intervals.icu and Claude servers)
npm run typecheck
```

Then, in the app:

1. **Connect** → paste your Intervals.icu API key (Intervals.icu → Settings → Developer Settings).
   Thresholds, your full activity history, fitness (CTL/ATL), HRV, resting HR, sleep and calendar
   races are pulled in. Optionally add an Anthropic API key on the same page to switch on the coach.
2. **Setup → Profile & zones** → check thresholds, max weekly hours, and how long you were off.
3. **Setup → Availability** → see the optimal week, then fix days or cap them where you must.
4. **Setup → Races & goals** → A/B/C races (past ones too) and season / long-term goals.
5. **Today** → *Generate my plan*, then **Plan** → *Push to devices*.

The app has five destinations — Today, Plan, Coach, Progress (season, history, insights) and Setup —
and the Today page walks a new install through these steps.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Anything non-local requires `APP_PASSWORD` |
| `APP_PASSWORD` | – | Enables HTTP Basic auth (any username) — set it if you host this for phone access, and put it behind HTTPS |
| `DATA_DIR` | `./data` | Where `state.json` lives |
| `ANTHROPIC_API_KEY` | – | Alternative to entering the coach's API key in the app |
| `COACH_MODEL` | `claude-opus-5-5` | Claude model used by the coach |

All data, including the Intervals.icu and Anthropic API keys, stays in `data/state.json` on the
machine running the app (git-ignored, owner-readable only). Keys are never sent to the browser.
When you use the coach, each message sends your plan, thresholds, recent training and readiness to
the Claude API.

## What it does

- **Season planning** — periodises backwards from every A-race (rebuild → base → build → specific →
  taper → race → transition), handles multiple A-races, gives B-races a short freshen-up and trains
  through C-races. Weekly load comes from a forward simulation of fitness (CTL) with a controlled
  ramp, recovery weeks (3:1 or 2:1) and scheduled threshold tests.
- **Race types** — sprint, Olympic, 70.3 and Ironman triathlons, sprint and standard duathlons,
  aquathlons, running races and bike events. With a duathlon or aquathlon as the target, the
  specific block, taper and race week shift time from the discipline that is not raced (kept at
  maintenance) to the ones that are.
- **Return to training** — a 2–6 week rebuild block sized by how long you were off: frequency, then
  volume, then intensity; bike intensity returns before run intensity; ends with re-testing.
- **Optimal week first** — by default no day has a time limit, so the plan lays out the week it
  would choose: long ride Saturday, long run Sunday, hard days spaced apart, strength consolidated
  onto hard days, one rest day. You then negotiate it down: fix swim, strength, long-ride, long-run
  and rest days, cap any day's time, and mark pool and gym access. A live preview re-flows the week
  on every change and shows what your limits cost against the optimal week, for a typical week now
  or the biggest week of the season. Date-specific exceptions cover travel.
- **Every week hits its own load target** — a corrective pass re-sizes the generated week to the
  target, and warnings about sessions that would not fit point at the limit responsible.
- **Structured workouts by power** — bike (FTP) and run (threshold/critical power), with pace or HR
  as alternatives per sport; swim sets from critical swim speed. VO2max (incl. 30/15s), threshold,
  over-unders, sweet spot, race-pace, durability long rides, bricks, hills, progression runs, tests.
- **Custom workouts** — build your own with repeats and ranges, save to a library, schedule them;
  the plan works around anything you pin.
- **Strength programme** — periodised with the season: anatomical adaptation → maximal strength →
  power/plyometrics → in-season maintenance, for gym or home equipment.
- **Daily readiness** — 7-day HRV trend against your own baseline, resting HR, sleep, form and a
  subjective check-in. One click shifts or replaces today's session when you are not recovered.
- **Execution-driven progression** — completed key sessions are graded rep by rep against their
  targets using the intervals Intervals.icu detects. Beat the targets and the next session of that
  type skips a level; miss them and it steps back. Long sessions report aerobic decoupling.
- **Course-aware racing** — upload bike and run GPX files for a race. You get an elevation profile,
  detected climbs, a physics-based split prediction and a variable-power pacing plan. In the
  specific block the race-pace bike session becomes the course's climbs (or surge-and-settle work
  for rolling terrain), hilly run courses add hill reps, and hot races add heat acclimation to the
  easy sessions of the last three weeks.
- **Past-race analysis** — add a race you have already done with its real date. The app links the
  swim, bike and run recorded that day (ignoring warm-ups), compares actual with modelled splits,
  works out the share of threshold you actually held on each leg and fits your effective CdA from
  the bike split and power. Those personal numbers then replace the generic assumptions in every
  future prediction and pacing plan (intensities for the same race type, CdA for all).
- **Age-group gap** — enter the splits that reach your goal; the app compares them with your
  predicted splits, shows what 1% of each threshold is worth on that course, and can point the
  plan's extra training time at the discipline furthest behind.
- **Comeback tracker** — fitness, volume, best session power and pace, and longest sessions since
  your return against the 12 months before the break, with the date planned fitness regains it.
- **Learned progression rate** — your past build blocks, and which of them ended in a sharp drop in
  training, give a personal CTL-per-week rate you can choose to drive the plan.
- **Niggle log** — log anything that hurts; severity 2 removes intensity in that sport for four
  days, severity 3 replaces runs with rides (or drops the session) for a week.
- **Weekly debrief** — a written review of the last seven days from the coach, on request.
- **Adapts to what you actually did** — after each sync the app compares done against planned and
  proposes changes to the rest of the week: protect the hard session after a day that went far
  beyond plan, trim easy volume when the week is running over its load target, and reschedule a
  missed key or long session only where a day has room and hard days stay apart. Apply with one
  click, keep the plan as is, or switch on automatic application in Profile.
- **Closed loop** — completed activities are matched to planned sessions; each re-plan starts from
  the fitness you actually have, so missed training is never "made up" by cramming.
- **AI coach** — a streaming Claude-backed chat that sees your profile, season, upcoming sessions, readiness
  and training history. Ask why a session is there or how to execute it, or tell it what to change:
  it can move, replace, add, skip and delete sessions, set availability for specific dates and
  re-plan. Changes are pinned and listed back to you; nothing reaches your devices until you push.
- **Training history** — the first sync imports every activity back to your first one (later syncs
  refresh the last 60 days): weekly volume by sport, all-time fitness curve, yearly totals, longest
  sessions, and a filterable activity list.
- **Undo** — re-plans, applied adjustments, coach changes, quick edits and deletions leave an undo
  point (the last ten are kept); the confirmation offers Undo and so does the Plan menu.
- **Device sync state** — the app remembers what it last pushed to Intervals.icu and flags sessions
  in the next two weeks that have changed or been removed since, on the Plan page and in the menu.
- **Unlink and relink activities** — if an activity was matched to the wrong session (an easy ride
  that landed on the sweet spot), open the session and unlink it: the session is open again and goes
  back to the day it was planned for, progression earned from the wrong grading is taken back, and
  the activity stays an unplanned extra that syncs never re-link. Open any unplanned activity to link
  it to the session it really was.
- **Quick edits and review** — lengthen or shorten an aerobic session by 15 minutes, or make a hard
  one easy, from its dialog; the four weeks just gone stay viewable in the Plan.
- **Goals** — performance, health, skill and life goals for the season and the long term.
- **Export** — structured workouts to Intervals.icu; `.ics` calendar feed for anything else.

## Devices

Workouts pushed to your Intervals.icu calendar reach devices like this:

- **Apple Watch** — Intervals.icu has no direct Watch link. Use a bridge app that reads your
  Intervals.icu calendar and sends structured workouts to the Watch (e.g. *Intervals Companion*,
  which uses Apple's WorkoutKit, or *Watchletic*). Check the app's notes for run-power / pace-target
  support on your watchOS version.
- **Garmin, Wahoo, Suunto, COROS, Zwift, …** — enable planned-workout upload for the service in
  Intervals.icu → Settings; sync is automatic after each push.

Re-pushing updates workouts in place and removes ones deleted here. Only events created by this app
(external id prefix `tricoach-`) are ever modified.

## Layout

```
src/engine/   adapt.ts (done-vs-planned adjustments, niggles)  execution.ts (rep grading, progression)
              course.ts (GPX, split prediction, pacing, age-group gap)  raceanalysis.ts (past races, personal model)  insights.ts (comeback, learned ramp)
              season.ts (periodisation, load)  week.ts (scheduler)  workouts.ts (library)
              strength.ts  readiness.ts  zones.ts (targets, Intervals.icu text)  plan.ts (state)
src/intervals.ts   Intervals.icu API client
src/coach.ts       Claude coach: context, tools, conversation loop
src/server.ts      HTTP API + static UI
public/            single-page UI (no build step)
test/              node:test suites
```

The training rationale and references are on the app's **Method** page.

## Limits worth knowing

- Activities that reached Intervals.icu **via Strava** are withheld by its API (Strava's terms), so
  they cannot be imported; the app counts them and tells you. Connect Garmin / Wahoo / Zwift /
  Apple Health directly to Intervals.icu, or bulk-upload your Strava export there, then re-import.
- The coach is tested against a local fake of the Claude API, not the live service.
- Split predictions depend on CdA, weight and the fixed race-intensity assumptions in
  `src/engine/course.ts`; calibrate CdA against a past result before trusting the bike split.
- Rep grading relies on Intervals.icu's interval detection and field names taken from memory of its
  API; if a session shows "could not be graded", the activity had no matching laps or intervals.

- The Intervals.icu integration is tested against a local fake of the API, not yet against the live
  service. If a push is rejected, the error from Intervals.icu is shown in the app.
- Load is estimated as hours × IF² × 100 per session; Intervals.icu's own numbers take over once
  activities are recorded.
- This is training software, not medical advice. If your break was for a cardiac, respiratory,
  bone-stress or hormonal reason, get clearance for high-intensity work before the first VO2max block.
