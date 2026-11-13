import { tuyaClient } from './tuya.js';
import { verifyAccess, verifySession, login, logout } from './auth.js';
import { getSettings, saveSettings, addLog, listSensors, listRules, kvGet, kvSet } from './db.js';
import { getWeather, geocode } from './weather.js';
import { tick, describe, sendNotification, getSmartAuto, runSmartAuto, readSensors } from './engine.js';
import { validateProps, capabilities, faults } from './ac.js';
import { hmToMin, localTime } from './rules.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

// ---------- rules ----------

const KINDS = ['schedule', 'condition', 'thermostat', 'warmup'];
const OPS = ['>', '>=', '<', '<=', '='];
const SOURCE_RE = /^(room|target|ac_on|outside|outside_feels|outside_humidity|forecast_max|forecast_min|tonight_min|sensors_avg|sensor:[\w-]+|sensor_hum:[\w-]+)$/;

function cleanRule(input) {
  const def = input.def || {};
  if (!KINDS.includes(def.kind)) throw new HttpError(400, 'Rule kind must be schedule, condition, thermostat or warmup');
  const name = String(input.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Rule needs a name');
  const days = Array.isArray(def.days) ? [...new Set(def.days.map(Number).filter((d) => d >= 1 && d <= 7))].sort() : [];
  const hm = (v) => (hmToMin(v) == null ? null : v);
  const conditions = (Array.isArray(def.conditions) ? def.conditions : []).slice(0, 8).map((c) => {
    if (!SOURCE_RE.test(c.src || '')) throw new HttpError(400, `Unknown condition source: ${c.src}`);
    if (!OPS.includes(c.op)) throw new HttpError(400, `Unknown operator: ${c.op}`);
    if (c.cmp) {
      if (!SOURCE_RE.test(c.cmp)) throw new HttpError(400, `Unknown comparison source: ${c.cmp}`);
      return { src: c.src, op: c.op, cmp: c.cmp, offset: Number(c.offset) || 0 };
    }
    const value = Number(c.value);
    if (!Number.isFinite(value)) throw new HttpError(400, 'Condition value must be a number');
    return { src: c.src, op: c.op, value };
  });
  const out = { kind: def.kind, days, conditions };
  if (def.kind === 'schedule') {
    out.at = hm(def.at);
    if (!out.at) throw new HttpError(400, 'Schedule needs a time (HH:MM)');
  } else if (def.kind === 'warmup') {
    out.window = null;
  } else {
    const from = hm(def.window?.from);
    const to = hm(def.window?.to);
    out.window = from && to ? { from, to } : null;
  }
  if (def.kind === 'warmup') {
    const w = def.warmup || {};
    const at = hm(w.at);
    const earliest = hm(w.earliest);
    if (!at || !earliest) throw new HttpError(400, 'Ready-by needs a time and an earliest start (HH:MM)');
    if (hmToMin(earliest) >= hmToMin(at)) throw new HttpError(400, 'The earliest start must be before the ready-by time');
    const target = Number(w.target);
    if (!Number.isFinite(target) || target < 16 || target > 32) throw new HttpError(400, 'Ready-by temperature must be 16–32°');
    out.warmup = {
      at,
      earliest,
      target: Math.round(target),
      mode: w.mode === 'cold' ? 'cold' : 'hot',
      fan: w.fan ? validateProps({ windspeed: w.fan }).windspeed : null,
      marginMin: Math.min(60, Math.max(0, Math.round(Number(w.marginMin ?? 15)))),
    };
    out.notify = def.notify ? String(def.notify).slice(0, 200) : '';
  } else if (def.kind === 'thermostat') {
    const th = def.thermostat || {};
    const target = Number(th.target);
    if (!Number.isFinite(target) || target < 10 || target > 35) throw new HttpError(400, 'Thermostat target must be 10–35°');
    if (!SOURCE_RE.test(th.sensor || 'room')) throw new HttpError(400, 'Unknown thermostat sensor');
    out.thermostat = {
      target,
      band: Math.min(3, Math.max(0.2, Number(th.band) || 0.5)),
      sensor: th.sensor || 'room',
      mode: ['cold', 'hot', 'auto'].includes(th.mode) ? th.mode : 'cold',
      fan: th.fan ? validateProps({ windspeed: th.fan }).windspeed : null,
      offset: Math.min(4, Math.max(0, Number(th.offset ?? 1))),
      minCycleMin: Math.min(60, Math.max(0, Number(th.minCycleMin ?? 6))),
      offAtEnd: th.offAtEnd !== false,
    };
  } else {
    const a = def.action || {};
    const action = {};
    if (a.power === 'on' || a.power === 'off') action.power = a.power;
    if (a.mode) action.mode = validateProps({ mode: a.mode }).mode;
    if (a.temp != null && a.temp !== '') action.temp = validateProps({ temp_set: a.temp }).temp_set;
    if (a.fan) action.fan = validateProps({ windspeed: a.fan }).windspeed;
    for (const k of ['swingV', 'swingH', 'eco', 'sleep', 'screen', 'heat']) if (typeof a[k] === 'boolean') action[k] = a[k];
    out.action = action;
    out.notify = def.notify ? String(def.notify).slice(0, 200) : '';
    if (def.kind === 'condition') out.cooldownMin = Math.min(1440, Math.max(0, Number(def.cooldownMin ?? 30)));
    if (!Object.keys(action).length && !out.notify) throw new HttpError(400, 'Rule needs an action or a notification');
  }
  return { name, enabled: input.enabled !== false, def: out };
}

// ---------- API ----------

async function api(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const tuya = tuyaClient(env);
  const deviceId = env.TUYA_DEVICE_ID;

  if (path === '/api/state' && method === 'GET') {
    const settings = await getSettings(env);
    const [props, info, weather, sensors, lastTick, smartAuto] = await Promise.all([
      tuya.properties(deviceId),
      tuya.info(deviceId).catch(() => null),
      getWeather(env, settings),
      listSensors(env),
      kvGet(env, 'last_tick'),
      getSmartAuto(env),
    ]);
    // Latest reading per sensor: one indexed row each (never scan the readings table —
    // this endpoint is polled every 30 s while the app is open).
    const latest = sensors.length
      ? await env.DB.batch(sensors.map((x) =>
          env.DB.prepare('SELECT source, temp, humidity, ts FROM readings WHERE source = ? ORDER BY ts DESC LIMIT 1').bind(`sensor:${x.id}`)))
      : [];
    const bySource = Object.fromEntries(latest.flatMap((r) => r.results).map((r) => [r.source, r]));
    return json({
      ac: props,
      online: info ? info.is_online ?? info.isOnline ?? info.online ?? null : null,
      caps: capabilities(props),
      faults: faults(props),
      weather: weather && { ...weather, hourly: undefined },
      sensors: sensors.map((s) => ({ id: s.id, name: s.name, ...(bySource[`sensor:${s.id}`] || {}) })),
      settings,
      smartAuto,
      lastTick,
      now: Date.now(),
    });
  }

  if (path === '/api/command' && method === 'POST') {
    const b = await body(request);
    let props;
    try {
      props = validateProps(b.props);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    if (!Object.keys(props).length) throw new HttpError(400, 'Nothing to send');
    await tuya.issue(deviceId, props);
    await addLog(env, 'manual', describe(props));
    return json({ ok: true });
  }

  if (path === '/api/smart-auto' && method === 'POST') {
    const b = await body(request);
    const sa = await getSmartAuto(env);
    if ('target' in b) {
      const t = Math.round(Number(b.target));
      if (!Number.isFinite(t) || t < 16 || t > 30) throw new HttpError(400, 'Smart Auto target must be 16–30°');
      sa.target = t;
    }
    if ('sensor' in b) {
      if (!/^(room|sensors_avg|sensor:[\w-]+)$/.test(b.sensor || '')) throw new HttpError(400, 'Unknown sensor');
      sa.sensor = b.sensor;
    }
    const wasEnabled = sa.enabled;
    if ('enabled' in b) sa.enabled = !!b.enabled;
    if (!sa.enabled) sa.state = {};
    else if (!wasEnabled) sa.state = {};
    await kvSet(env, 'smart_auto', sa);

    if (sa.enabled && !wasEnabled) {
      // Start right away instead of waiting for the next check.
      const settings = await getSettings(env);
      const [ac, sensorRows] = await Promise.all([tuya.properties(deviceId), listSensors(env)]);
      const sensors = sa.sensor === 'room' ? {} : await readSensors(env, tuya, sensorRows);
      const logs = await runSmartAuto(env, tuya, deviceId, { now: Date.now(), local: localTime(Date.now(), settings.tz), ac, sensors, caps: capabilities(ac) });
      for (const [kind, msg] of logs) await addLog(env, kind, msg);
    } else if (sa.enabled && 'target' in b && sa.state.active) {
      await tuya.issue(deviceId, { temp_set: sa.target });
      await addLog(env, 'manual', `Smart Auto target ${sa.target}°`);
    } else if (wasEnabled && !sa.enabled) {
      await addLog(env, 'manual', 'Smart Auto off');
    }
    return json(await getSmartAuto(env));
  }

  if (path === '/api/rules' && method === 'GET') return json(await listRules(env));

  if (path === '/api/rules' && method === 'POST') {
    const r = cleanRule(await body(request));
    const now = Date.now();
    const { meta } = await env.DB.prepare('INSERT INTO rules (name, enabled, sort, def, state, created, updated) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM rules), ?, ?, ?, ?)')
      .bind(r.name, r.enabled ? 1 : 0, JSON.stringify(r.def), '{}', now, now)
      .run();
    await addLog(env, 'info', `Rule created: ${r.name}`);
    return json({ id: meta.last_row_id });
  }

  if (path === '/api/rules/order' && method === 'POST') {
    const { ids } = await body(request);
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be an array');
    await env.DB.batch(ids.map((id, i) => env.DB.prepare('UPDATE rules SET sort = ? WHERE id = ?').bind(i + 1, Number(id))));
    return json({ ok: true });
  }

  const ruleMatch = /^\/api\/rules\/(\d+)$/.exec(path);
  if (ruleMatch && method === 'PUT') {
    const id = Number(ruleMatch[1]);
    const b = await body(request);
    // A bare { enabled } toggles without touching the definition.
    if (Object.keys(b).length === 1 && 'enabled' in b) {
      await env.DB.prepare(`UPDATE rules SET enabled = ?, state = CASE WHEN json_extract(state, '$.rates') IS NOT NULL THEN json_object('rates', json(json_extract(state, '$.rates'))) ELSE '{}' END, updated = ? WHERE id = ?`).bind(b.enabled ? 1 : 0, Date.now(), id).run();
      return json({ ok: true });
    }
    const r = cleanRule(b);
    // Definition changed: reset state so the rule starts fresh (but keep what a
    // ready-by rule has learned about warm-up speeds).
    await env.DB.prepare(`UPDATE rules SET name = ?, enabled = ?, def = ?, state = CASE WHEN json_extract(state, '$.rates') IS NOT NULL THEN json_object('rates', json(json_extract(state, '$.rates'))) ELSE '{}' END, updated = ? WHERE id = ?`)
      .bind(r.name, r.enabled ? 1 : 0, JSON.stringify(r.def), Date.now(), id)
      .run();
    return json({ ok: true });
  }
  if (ruleMatch && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(Number(ruleMatch[1])).run();
    return json({ ok: true });
  }

  if (path === '/api/history' && method === 'GET') {
    const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours')) || 24));
    const since = Date.now() - hours * 3_600_000;
    const { results } = await env.DB.prepare('SELECT ts, source, temp, humidity, power, target, mode FROM readings WHERE ts >= ? ORDER BY ts').bind(since).all();
    const series = {};
    for (const r of results) (series[r.source] ||= []).push(r);
    return json({ since, series });
  }

  if (path === '/api/log' && method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const kind = url.searchParams.get('kind');
    const { results } = kind
      ? await env.DB.prepare('SELECT ts, kind, message FROM log WHERE kind = ? ORDER BY id DESC LIMIT ?').bind(kind, limit).all()
      : await env.DB.prepare('SELECT ts, kind, message FROM log ORDER BY id DESC LIMIT ?').bind(limit).all();
    return json(results);
  }

  if (path === '/api/settings' && method === 'GET') return json(await getSettings(env));

  if (path === '/api/settings' && method === 'PUT') {
    const b = await body(request);
    const patch = {};
    if ('name' in b) patch.name = String(b.name).slice(0, 60);
    if ('place' in b) patch.place = String(b.place).slice(0, 120);
    if ('lat' in b) patch.lat = b.lat == null ? null : Number(b.lat);
    if ('lon' in b) patch.lon = b.lon == null ? null : Number(b.lon);
    if ('tz' in b) {
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: b.tz });
        patch.tz = b.tz;
      } catch {
        throw new HttpError(400, 'Unknown time zone');
      }
    }
    if ('pollMinutes' in b) patch.pollMinutes = [1, 2, 5, 10, 15].includes(Number(b.pollMinutes)) ? Number(b.pollMinutes) : 5;
    if ('ntfyTopic' in b) patch.ntfyTopic = String(b.ntfyTopic).trim().slice(0, 200);
    const s = await saveSettings(env, patch);
    if ('lat' in patch) await getWeather(env, s, { force: true });
    return json(s);
  }

  if (path === '/api/pause' && method === 'POST') {
    const { minutes } = await body(request);
    const m = Math.max(0, Math.min(7 * 1440, Number(minutes) || 0));
    const s = await saveSettings(env, { pauseUntil: m ? Date.now() + m * 60_000 : 0 });
    await addLog(env, 'info', m ? `Automations paused for ${m >= 60 ? `${Math.round(m / 60)} h` : `${m} min`}` : 'Automations resumed');
    return json(s);
  }

  if (path === '/api/geocode' && method === 'GET') return json(await geocode(url.searchParams.get('q') || ''));

  if (path === '/api/sensors' && method === 'POST') {
    const b = await body(request);
    const id = String(b.id || '').trim();
    const name = String(b.name || '').trim().slice(0, 40) || 'Sensor';
    if (!/^[\w-]{6,64}$/.test(id)) throw new HttpError(400, 'That does not look like a Tuya device ID');
    if (id === deviceId) throw new HttpError(400, 'That is the AC itself — its temperature is already used as “Room (AC)”.');
    const model = await tuya.model(id);
    const props = (model.services || []).flatMap((s) => s.properties || []);
    const pick = (codes, re) =>
      props.find((p) => codes.includes(p.code)) || props.find((p) => p.typeSpec?.type === 'value' && re.test(`${p.code} ${p.typeSpec?.unit || ''}`));
    const t = pick(['va_temperature', 'temp_current', 'temperature', 'temp_indoor'], /temp|℃|°C/i);
    const h = pick(['va_humidity', 'humidity_value', 'humidity', 'humidity_indoor'], /humid|%/i);
    if (!t) throw new HttpError(400, 'No temperature reading found on that device');
    await env.DB.prepare('INSERT OR REPLACE INTO sensors (id, name, temp_code, temp_scale, hum_code, hum_scale, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, t.code, t.typeSpec?.scale || 0, h?.code || null, h?.typeSpec?.scale || 0, Date.now())
      .run();
    await addLog(env, 'info', `Sensor added: ${name}`);
    return json({ ok: true, tempCode: t.code, humCode: h?.code || null });
  }
  const sensorMatch = /^\/api\/sensors\/([\w-]+)$/.exec(path);
  if (sensorMatch && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM sensors WHERE id = ?').bind(sensorMatch[1]).run();
    return json({ ok: true });
  }

  if (path === '/api/tick' && method === 'POST') return json(await tick(env, { force: true }));

  if (path === '/api/notify-test' && method === 'POST') {
    const s = await getSettings(env);
    if (!s.ntfyTopic) throw new HttpError(400, 'Set a ntfy topic first');
    const ok = await sendNotification(s, 'AC control', 'Test notification — it works.');
    return json({ ok });
  }

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/login' && request.method === 'POST') return login(request, env);
    if (url.pathname === '/api/logout' && request.method === 'POST') return logout();
    // Household password session, or (while it's still switched on) Cloudflare Access.
    const user = (await verifySession(request, env)) || (await verifyAccess(request, env));
    if (!user) return json({ error: 'Not authorised', login: !!env.APP_PASSWORD }, 401);
    try {
      return await api(request, env, url);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json({ error: e.message || 'Server error' }, status);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      tick(env).catch(async (e) => {
        console.error(e);
        await addLog(env, 'error', `Tick failed: ${e.message}`).catch(() => {});
      }),
    );
  },
};
