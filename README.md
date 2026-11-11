# Triathlon Coach

A personal, adaptive triathlon training platform. It plans a whole season around your races, builds
each week from your real availability, prescribes every session by power (bike **and** run), pace or
heart rate, adapts day to day from your recovery data, and pushes structured workouts to
[Intervals.icu](https://intervals.icu) — and from there to your watch, head unit and trainer apps.

It is written for a trained athlete. No "walk/jog" scaffolding: intensity is real, load is driven by
your actual fitness, and the only conservative element is a deliberate return-to-training block
after time off.

## Run it

Requires Node.js ≥ 22.18. There are no dependencies to install.

```bash
npm start            # http://127.0.0.1:3000
npm test             # engine + API tests (uses a fake Intervals.icu)
```

Then, in the app:

1. **Connect** → paste your Intervals.icu API key (Intervals.icu → Settings → Developer Settings).
   Thresholds, fitness (CTL/ATL), HRV, resting HR, sleep, activities and calendar races are pulled in.
2. **Profile & zones** → check thresholds, max weekly hours, and how long you were off.
3. **Availability** → minutes per weekday, pool and gym access, date-specific exceptions.
4. **Races & goals** → A/B/C races and season / long-term goals.
5. **Today** → *Generate my plan*, then **Plan** → *Push to Intervals.icu*.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Anything non-local requires `APP_PASSWORD` |
| `APP_PASSWORD` | – | Enables HTTP Basic auth (any username) — set it if you host this for phone access, and put it behind HTTPS |
| `DATA_DIR` | `./data` | Where `state.json` lives |

All data, including the Intervals.icu API key, stays in `data/state.json` on the machine running the
app (git-ignored, owner-readable only). The key is never sent to the browser.

## What it does

- **Season planning** — periodises backwards from every A-race (rebuild → base → build → specific →
  taper → race → transition), handles multiple A-races, gives B-races a short freshen-up and trains
  through C-races. Weekly load comes from a forward simulation of fitness (CTL) with a controlled
  ramp, recovery weeks (3:1 or 2:1) and scheduled threshold tests.
- **Return to training** — a 2–6 week rebuild block sized by how long you were off: frequency, then
  volume, then intensity; bike intensity returns before run intensity; ends with re-testing.
- **Availability-aware weeks** — long sessions on your big days, hard days spaced apart, swims only
  on pool days, strength consolidated onto hard days, one protected rest day, travel exceptions.
- **Structured workouts by power** — bike (FTP) and run (threshold/critical power), with pace or HR
  as alternatives per sport; swim sets from critical swim speed. VO2max (incl. 30/15s), threshold,
  over-unders, sweet spot, race-pace, durability long rides, bricks, hills, progression runs, tests.
- **Custom workouts** — build your own with repeats and ranges, save to a library, schedule them;
  the plan works around anything you pin.
- **Strength programme** — periodised with the season: anatomical adaptation → maximal strength →
  power/plyometrics → in-season maintenance, for gym or home equipment.
- **Daily readiness** — 7-day HRV trend against your own baseline, resting HR, sleep, form and a
  subjective check-in. One click shifts or replaces today's session when you are not recovered.
- **Closed loop** — completed activities are matched to planned sessions; each re-plan starts from
  the fitness you actually have, so missed training is never "made up" by cramming.
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
src/engine/   season.ts (periodisation, load)  week.ts (scheduler)  workouts.ts (library)
              strength.ts  readiness.ts  zones.ts (targets, Intervals.icu text)  plan.ts (state)
src/intervals.ts   Intervals.icu API client
src/server.ts      HTTP API + static UI
public/            single-page UI (no build step)
test/              node:test suites
```

The training rationale and references are on the app's **Method** page.

## Limits worth knowing

- The Intervals.icu integration is tested against a local fake of the API, not yet against the live
  service. If a push is rejected, the error from Intervals.icu is shown in the app.
- Load is estimated as hours × IF² × 100 per session; Intervals.icu's own numbers take over once
  activities are recorded.
- This is training software, not medical advice. If your break was for a cardiac, respiratory,
  bone-stress or hormonal reason, get clearance for high-intensity work before the first VO2max block.
