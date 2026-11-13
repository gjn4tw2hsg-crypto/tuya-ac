# AC Control

Personal web app for the Electriq AC (Tuya Wi-Fi, device `bfefd1b63666835343vuwp`), with
automations, outside weather and extra temperature sensors. Runs entirely on Cloudflare's
free plan: one Worker (API + web app), a D1 database, a once-a-minute Cron Trigger, and
Cloudflare Access for login.

```
public/        web app (plain HTML/CSS/JS, installable on iPhone + Mac)
src/index.js   API routes + cron entry point
src/engine.js  one automation tick: read AC/sensors/weather → evaluate rules → act → record
src/rules.js   pure rule evaluation (schedule / condition / thermostat)
src/tuya.js    Tuya Cloud v2 "Things" client (+ mock AC for local dev)
src/weather.js Open-Meteo weather + place search (postcodes.io for UK postcodes)
src/auth.js    Cloudflare Access JWT check
migrations/    D1 schema
```

## Local development

`.dev.vars` sets `TUYA_MOCK=1` (simulated AC, no real device touched) and a local `APP_PASSWORD`.

```bash
npm install
npm run db:local
npm run dev            # http://localhost:8787 ; trigger cron: /__scheduled?cron=*+*+*+*+*
npm test               # rule engine tests
```

## Deploying

1. `npx wrangler login`
2. `npx wrangler d1 create ac-control` → put the printed `database_id` into `wrangler.jsonc`.
3. `npm run db:remote`
4. `npx wrangler secret put TUYA_CLIENT_SECRET` → paste the Access Secret from the Tuya console.
5. In `wrangler.jsonc`, uncomment `routes` and set your subdomain, e.g. `ac.example.com`.
6. `npm run deploy`

Until step 7 is done, every API call returns 401. That's deliberate: the app can't be used by anyone.

7. **Household password**: `npx wrangler secret put APP_PASSWORD`. Each device logs in once and is
   remembered for 180 days; changing the password signs everyone out.

   *Optional:* **Cloudflare Access** can also sit in front (the Worker accepts either):
   - Domain: the subdomain from step 5. Session duration: 1 month.
   - Policy: Allow → Emails → your email address. Login method: one-time PIN.
   - Copy the **Application Audience (AUD) tag** into `ACCESS_AUD`, and your team domain
     (`<team>.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`.
   - `npm run deploy` again.

## Installing

- **iPhone:** open the URL in Safari → sign in with the emailed code → Share → *Add to Home Screen*.
- **Mac:** open it in Safari → File → *Add to Dock*.

## Rules

- **At a time**: fires once at HH:MM on chosen days, if its conditions hold (e.g. forecast high > 26°).
- **When…**: fires each time its conditions *become* true, e.g. outside < room − 2° while the AC is on.
  Because it's edge-triggered, it won't keep undoing your manual changes.
- **Thermostat**: during a time window, switches the AC on/off to hold a target measured by any
  sensor (or the average of all sensors). If you switch the AC off yourself during the window, it
  stays off until the next window. It has a minimum on/off cycle time to protect the compressor.

When rules clash in the same check, the lower one in the list wins. *Pause 1 h / 3 h* stops all
automations. Notifications go through [ntfy](https://ntfy.sh). Use a long random topic name.

## Tuya API usage

Each check costs one Tuya call for the AC plus one per sensor. The app also makes a call every 30 s
while it's open on the Control screen. Pick the check interval in Settings to stay within your Tuya
plan's quota. The Tuya IoT Core trial must be renewed in the Tuya console when it expires.
