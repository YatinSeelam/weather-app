# Weather Monitoring

Monitor severe weather inside a radius around a U.S. ZIP code: official National Weather Service
alerts plus system-detected freezing, wind and rain risks, on an interactive map, with saved
monitors that are re-checked on a schedule.

No database, no accounts, no API keys. Everything runs with `pnpm dev`.

## Run it

```bash
pnpm install
pnpm dev            # http://localhost:3000/weather-monitor
```

Other commands:

```bash
pnpm test           # unit + integration tests (network mocked)
pnpm lint
pnpm typecheck
pnpm build && pnpm start
```

All weather shown is live. There is no simulated or fallback weather anywhere in the app;
hand-written fixtures exist only inside `lib/weather/__tests__/`.

Check that the live sources are reachable:

```bash
curl http://localhost:3000/api/weather/health
```

In development every check also prints a `LIVE WEATHER CHECK` trace to the server console: the
resolved coordinates, how many alerts NWS returned, how many intersect the radius, and how many
forecast samples succeeded.

## Configuration

All optional; see `.env.example`.

| Variable | Purpose |
| --- | --- |
| `NWS_USER_AGENT` | How this app identifies itself to api.weather.gov. NWS asks for contact details, e.g. `my-app (ops@example.com)`. |
| `RESEND_API_KEY` | Enables email delivery for saved monitors through [Resend](https://resend.com). |
| `EMAIL_FROM` | Sender, e.g. `Weather Monitor <alerts@yourdomain.com>` (domain verified in Resend). Default `onboarding@resend.dev` delivers only to the Resend account owner. |
| `EMAIL_TIME_ZONE` | IANA zone for times inside emails. Default `America/New_York`. |
| `CRON_SECRET` | Bearer token for `/api/cron/weather-monitors`. Required in production to use that endpoint. |
| `WEATHER_SCHEDULER` | `off` disables the in-process scheduler. |
| `WEATHER_DATA_DIR`, `WEATHER_CACHE_DIR` | Where saved monitors and lookup caches live (default `./data`, `./.cache/weather`). |
| `NEXT_PUBLIC_MAP_STYLE_URL` | MapLibre basemap style. Defaults to OpenFreeMap (OpenStreetMap data, no key). |

## How it works

**Radius.** The ZIP code is resolved to a center point server-side (Zippopotam.us, cached on
disk). The radius is a true geodesic circle, both on the map and in the math.

**Official alerts.** One request fetches every active NWS alert in the country
(`/alerts/active`, cached for 60 seconds and shared by all checks). An alert is kept when its area
intersects the circle: the distance from the center to the nearest edge of the alert area is at
most the radius. This is an intersection test, not a centroid test, so an area that only clips
the circle counts.

Most NWS alerts carry no geometry of their own; they are issued for forecast zones or counties.
For those, the app fetches the boundaries of the affected zones (`/zones/{type}/{id}`, cached on
disk for 30 days) and tests those instead. A coarse state/marine-area lookup avoids fetching
zones on the other side of the country. If zone boundaries cannot be loaded, the alert is
reported as unplaceable in a warning rather than guessed at.

**Detected risks.** A hexagonal lattice of sample points covers the circle (7 points at 25 mi up
to 61 at 150 mi). Each point is mapped to its NWS forecast grid cell (`/points`, cached on disk)
and that cell's raw forecast (`/gridpoints`, cached 10 minutes) is checked against the thresholds
in `lib/weather/constants.ts` for the next 12 hours. Requests run at most 8 at a time with
timeouts and bounded retries; a point that fails is counted and reported, never fatal.

**When a source is down.** A failed request is never reported as clear weather. If the alert
feed cannot be read the check fails with "Unable to retrieve live NWS alerts" and shows the last
successful check time. If forecasts cannot be read, official alerts are still shown and the
result is marked incomplete; an empty incomplete result says so instead of "No active weather
risks detected". Every result carries a `source` object naming the providers, the hosts called,
when the alert feed was fetched, and how complete each part was.

**Monitors.** Saved monitors live in `data/weather-monitors.json` behind a small `MonitorStore`
interface shaped like the database tables it would become. One worker ticks every minute, picks
the enabled monitors whose `nextCheckAt` has passed, runs them, and sets the next check time. It
runs in-process under `next dev` / `next start`; `/api/cron/weather-monitors` does the same job
for an external cron.

**Email updates.** A monitor carries a list of email addresses (zero or more) and a send mode.
After each run the runner builds one `MonitorUpdate` (run status, what changed, everything
active now) and hands it to the `WeatherNotificationProvider`:

- *Every check* (default): one email per scheduled run, so a 15-minute monitor emails every
  15 minutes, including "no active risks" and "unable to check" so silence is never mistaken
  for calm weather.
- *Only changes*: an email only when a risk is NEW, ESCALATED or UPDATED. Expiries are
  recorded but not emailed.

Each run compares the active risks with the monitor's stored state to classify changes as NEW,
UPDATED, ESCALATED, UNCHANGED or EXPIRED. With `RESEND_API_KEY` set the provider is
`ResendEmailProvider` (one POST to Resend's API, all recipients on one message); without it the
log provider writes to the server log and the UI says email is not configured. Other channels
implement the same interface and register with `setNotificationProvider`.

## Layout

```
app/weather-monitor/page.tsx        the page
app/api/weather/check               POST  run a radius check
app/api/weather/geocode             GET   ZIP preview
app/api/weather/health              GET   are NWS, the geocoder and storage reachable
app/api/weather/monitors[/id]       saved monitors: list, create, update, delete
app/api/cron/weather-monitors       run due monitors
components/weather/                 form, map, summary, results, saved monitors
lib/weather/                        domain: NWS client, geography, sampling, risk engine,
                                    alert change detection, monitor store / runner / scheduler
lib/weather/__tests__/              tests
```

Weather data and alerts from NOAA / National Weather Service.
