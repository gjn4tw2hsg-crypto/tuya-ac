# Tuya AC for the Electriq Easy-fit air conditioner

A web app for the **Electriq Easy-fit** air conditioner, model
[**EIQ-9WMINV**](https://www.electriq.co.uk/p/eiq-9wminv/electriq-9000-btu-panasonic-powered-smart-wall-mounted-split-air-conditioner-with-heat-pump-5-meters-pipe-kit-and-5)
(9000 BTU, Panasonic-powered, wall-mounted split with heat pump), which connects through
Tuya's Smart Life app. Control it from your phone,
see the room and outside temperature, and let it heat or cool by itself with rules, including a
**smart warm-up** that has the room ready by a set time, judged from the weather forecast and how
long warming up took on earlier days.

It runs in **your own** free Cloudflare account, on a free `…workers.dev` address. No domain, no
server, no monthly cost.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gjn4tw2hsg-crypto/tuya-ac)

> **Made for the Electriq Easy-fit EIQ-9WMINV** (Tuya model `00000035n3`) and tested on it. Other Tuya air
> conditioners may work if they report the same controls (`Power`, `temp_set`, `temp_current`,
> `mode`, `windspeed`, …); ones that use different names won't respond until `src/ac.js` is
> adjusted.

## Step by step

You need: your Electriq Easy-fit already working in the **Smart Life** (or Tuya Smart) app, a
**GitHub** account, and a free **Cloudflare** account. Allow about 30 minutes.

### 1. Get your Tuya keys (about 15 minutes)

1. Sign up at [platform.tuya.com](https://platform.tuya.com) (free).
2. **Cloud › Development › Create Cloud Project**. Industry *Smart Home*, development method
   *Smart Home*, and the **data centre that matches your Smart Life account's region** (for the UK
   and Europe: *Central Europe*). Accept the suggested API services.
3. In the project, **Devices › Link App Account › Add App Account**, and scan the QR code with
   the Smart Life app (Me › the scan icon at the top). Your air conditioner appears under
   **All Devices**. Copy the Easy-fit's **Device ID**.
4. On the project's **Overview**, copy the **Access ID** and **Access Secret**.
5. Check **Service API** includes *IoT Core*. Its free trial lasts a few months; when Tuya emails
   that it's ending, extend it on the same page (free for personal use).

### 2. Put the app in your Cloudflare account (about 5 minutes)

1. Press **Deploy to Cloudflare** above and sign in to Cloudflare and GitHub.
2. Fill in the boxes it shows:
   - `TUYA_CLIENT_ID`: the Access ID
   - `TUYA_CLIENT_SECRET`: the Access Secret
   - `TUYA_DEVICE_ID`: the Device ID
   - `APP_PASSWORD`: a long password you'll use to open the app
   - `TUYA_BASE`: leave as is for Europe; otherwise see the note next to it
3. Press **Create and deploy**. Cloudflare copies the code to your GitHub, creates the database
   and puts the app live. When it's done, open the address it shows
   (`https://tuya-ac.<your-name>.workers.dev`).

### 3. First time in the app (2 minutes)

1. Type your password. Each phone or computer is remembered for 180 days.
2. **Settings › Location**: search your postcode or town (for the outside temperature and forecast).
3. **Control**: switch the unit on and off once to check it responds.
4. On iPhone: Share › *Add to Home Screen*. On Mac Safari: File › *Add to Dock*.

### 4. Set up the rules for steady, economical heating (5 minutes)

Heat pumps lose a lot of time defrosting in cold, damp weather, so it's cheaper and more
comfortable to **hold a steady low temperature on cold nights** than to heat up a cold room,
and to **switch off on mild nights**. In **Rules › New rule**, add these four (change the times and
temperatures to suit you):

| Name | Type | Settings |
| --- | --- | --- |
| **Smart warm-up: 25° by 08:00** | Template *Warm by start of work* (Ready by) | Days Mon–Fri · Ready at 08:00 · 25° · Heat · Never start before 05:00 · Spare minutes 15 |
| **Steady 16° after work if cold night** | When… | 15:05 to 05:00 · every day · when *Tonight's forecast low (to 08:00)* is below 5 · Then: Turn on, Heat, 16° · wait 30 min |
| **Off after work if mild night** | At a time | 15:05 · every day · only if *Tonight's forecast low (to 08:00)* is at least 5 · Then: Turn off |
| **Heat when cold inside** | When… | All day · when *Room temp* is below 8 · Then: Turn on, Heat, 16° · wait 30 min |

What happens then, each weekday:

- **15:05:** if tonight's forecast low is under 5°, it drops to a steady 16° for the night (and
  switches to that later in the evening if the forecast turns colder). If not, it switches off.
- **Any time:** if the room falls below 8°, it heats to 16°.
- **From 05:00:** every few minutes it works out how long getting to 25° would take, from the
  room, the outside temperature and the forecast until 08:00, plus how fast it warmed up on
  earlier mornings. It switches on as late as it safely can, then stays on so the unit holds 25°
  itself without stopping and starting.
- After each warm-up it remembers how long it really took for that outside temperature, and uses
  that next time. The rule's edit screen shows what it has learned.

## How it works

```
public/        web app (plain HTML/CSS/JS, installable on iPhone + Mac)
src/index.js   API routes + cron entry point
src/engine.js  one automation tick: read AC/sensors/weather → evaluate rules → act → record
src/rules.js   rule evaluation (schedule / condition / thermostat / ready by)
src/tuya.js    Tuya Cloud v2 "Things" client (+ simulated AC for local development)
src/weather.js Open-Meteo weather and hourly forecast + place search (postcodes.io for UK postcodes)
src/auth.js    household password (+ optional Cloudflare Access)
migrations/    database schema
```

### Rule types

- **At a time**: fires once at HH:MM on chosen days, if its conditions hold (e.g. forecast high > 26°).
- **When…**: fires each time its conditions *become* true, e.g. tonight's forecast low drops below 5°.
  Because it only fires on the change, it won't keep undoing your manual changes.
- **Thermostat**: during a time window, switches the AC on and off to hold a target measured by any
  sensor. It has a minimum on/off time to protect the compressor.
- **Ready by**: switches on once a day, early enough to reach a temperature by a set time, then
  stays on. It learns the warm-up speed for each outside temperature.

Conditions can use the room, outside and feels-like temperature, outside humidity, today's
forecast high and low, **tonight's forecast low (to 08:00)**, extra Tuya sensors, and whether the
AC is on. When rules clash in the same check, the lower one in the list wins. *Pause 1 h / 3 h*
stops all automations. Notifications go through [ntfy](https://ntfy.sh); use a long random topic name.

### Tuya API usage

Each check costs one Tuya call for the AC plus one per sensor. The app also makes a call every 30 s
while it's open on the Control screen. Pick the check interval in Settings to stay within your Tuya
plan's quota.

## Local development

```bash
npm install
printf 'TUYA_MOCK=1\nAPP_PASSWORD=test\n' > .dev.vars   # simulated AC, no real device touched
npm run db:local
npm run dev            # http://localhost:8787 ; run the rules now: /__scheduled?cron=*+*+*+*+*
npm test               # rule tests
```

## Deploying from your computer instead of the button

```bash
npx wrangler login
npm run deploy                                  # creates the database on the first run
npx wrangler secret put TUYA_CLIENT_ID          # and TUYA_CLIENT_SECRET, TUYA_DEVICE_ID, APP_PASSWORD
```

### Your own copy with your own settings

To use your own domain, Cloudflare Access or an existing database, copy `wrangler.jsonc` to
`wrangler.mine.jsonc` (it's kept out of git), change it there, and deploy with
`npm run deploy:mine`.
