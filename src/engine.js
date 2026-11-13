// One automation "tick": read the world, evaluate rules, act, record.
import { tuyaClient } from './tuya.js';
import { getSettings, addLog, listSensors, listRules, kvGet, kvSet } from './db.js';
import { getWeather } from './weather.js';
import { evaluateRules, mergeCommands, localTime, hmToMin, smartAutoStep, SMART_AUTO_DEFAULTS } from './rules.js';
import { capabilities, diffProps, faults, diffFaults } from './ac.js';

const RETENTION_DAYS = 90;

export function scaled(value, scale) {
  return typeof value === 'number' ? value / 10 ** (scale || 0) : null;
}

export async function readSensors(env, tuya, sensors) {
  const out = {};
  await Promise.all(
    sensors.map(async (s) => {
      try {
        const p = await tuya.properties(s.id);
        out[s.id] = {
          name: s.name,
          temp: s.temp_code ? scaled(p[s.temp_code], s.temp_scale) : null,
          humidity: s.hum_code ? scaled(p[s.hum_code], s.hum_scale) : null,
        };
      } catch (e) {
        out[s.id] = { name: s.name, temp: null, humidity: null, error: e.message };
      }
    }),
  );
  return out;
}

export async function sendNotification(settings, title, message) {
  if (!settings.ntfyTopic) return false;
  const url = settings.ntfyTopic.startsWith('http') ? settings.ntfyTopic : `https://ntfy.sh/${encodeURIComponent(settings.ntfyTopic)}`;
  const res = await fetch(url, { method: 'POST', body: message, headers: { Title: title, Tags: 'snowflake' } });
  return res.ok;
}

// Whether a scheduled rule is due this minute (so we don't wait for the poll interval).
function scheduleDue(rules, local) {
  return rules.some((r) => {
    if (!r.enabled || r.def.kind !== 'schedule') return false;
    const at = hmToMin(r.def.at);
    const late = local.minutes - at;
    return at != null && late >= 0 && late < 60 && r.state.lastDate !== local.date;
  });
}

export async function tick(env, { force = false } = {}) {
  const now = Date.now();
  const settings = await getSettings(env);
  const local = localTime(now, settings.tz);
  const rules = await listRules(env);
  const minuteIndex = Math.floor(now / 60_000);
  const poll = Math.max(1, Number(settings.pollMinutes) || 5);

  if (!force && minuteIndex % poll !== 0 && !scheduleDue(rules, local)) return { skipped: true };

  const tuya = tuyaClient(env);
  const deviceId = env.TUYA_DEVICE_ID;
  let ac;
  try {
    ac = await tuya.properties(deviceId);
  } catch (e) {
    await addLog(env, 'error', `Reading the AC failed: ${e.message}`);
    return { error: e.message };
  }
  const [sensorRows, weather] = await Promise.all([listSensors(env), getWeather(env, settings)]);
  const sensors = await readSensors(env, tuya, sensorRows);
  const caps = capabilities(ac);

  // Record readings
  const inserts = [
    env.DB.prepare('INSERT INTO readings (ts, source, temp, power, target, mode) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(now, 'ac', ac.temp_current ?? null, ac.Power ? 1 : 0, ac.temp_set ?? null, ac.mode ?? null),
  ];
  if (weather) {
    inserts.push(env.DB.prepare('INSERT INTO readings (ts, source, temp, humidity) VALUES (?, ?, ?, ?)').bind(now, 'outside', weather.temp, weather.humidity));
  }
  for (const [id, s] of Object.entries(sensors)) {
    if (s.temp != null || s.humidity != null) {
      inserts.push(env.DB.prepare('INSERT INTO readings (ts, source, temp, humidity) VALUES (?, ?, ?, ?)').bind(now, `sensor:${id}`, s.temp, s.humidity));
    }
  }
  if (minuteIndex % 1440 < poll) {
    inserts.push(env.DB.prepare('DELETE FROM readings WHERE ts < ?').bind(now - RETENTION_DAYS * 86_400_000));
    inserts.push(env.DB.prepare('DELETE FROM log WHERE ts < ?').bind(now - RETENTION_DAYS * 86_400_000));
  }
  await env.DB.batch(inserts);

  // Evaluate rules
  const ctx = { now, local, ac, sensors, weather, caps };
  const result = evaluateRules(rules, ctx);
  const paused = settings.pauseUntil > now;
  const desired = mergeCommands(result.commands);
  const change = diffProps(ac, desired);

  const stmts = [];
  const logLine = (kind, msg) => stmts.push(env.DB.prepare('INSERT INTO log (ts, kind, message) VALUES (?, ?, ?)').bind(now, kind, msg));
  for (const l of result.logs) logLine('rule', l);

  // Fault history: log (and notify about) fault codes as they appear and clear.
  const currFaults = faults(ac);
  const prevFaults = (await kvGet(env, 'last_faults')) || [];
  const { added, cleared } = diffFaults(prevFaults, currFaults);
  if (added.length || cleared.length) {
    for (const f of added) logLine('fault', `Fault code ${f} reported by the AC`);
    for (const f of cleared) logLine('fault', `Fault code ${f} cleared`);
    await kvSet(env, 'last_faults', currFaults);
    if (added.length) {
      const msg = `The AC reported fault code${added.length > 1 ? 's' : ''} ${added.join(', ')}. Check the unit's manual.`;
      try {
        if (await sendNotification(settings, 'AC fault', msg)) logLine('notify', `AC fault: ${msg}`);
      } catch (e) {
        logLine('error', `Fault notification failed: ${e.message}`);
      }
    }
  }

  // If the command wasn't delivered (paused or failed), don't remember the rules
  // behind it as having acted — they'll try again on the next tick.
  let delivered = true;
  if (Object.keys(change).length) {
    const why = result.commands.map((c) => `${c.name} (${c.reason})`).join(', ');
    if (paused) {
      delivered = false;
      logLine('rule', `Paused — would have sent ${describe(change)} for ${why}`);
    } else {
      try {
        await tuya.issue(deviceId, change);
        logLine('rule', `${describe(change)} — ${why}`);
      } catch (e) {
        delivered = false;
        logLine('error', `Sending ${describe(change)} failed: ${e.message}`);
      }
    }
  }
  const actedRules = new Set(result.commands.map((c) => c.ruleId));
  for (const [id, st] of result.states) {
    if (!delivered && actedRules.has(id)) continue;
    stmts.push(env.DB.prepare('UPDATE rules SET state = ? WHERE id = ?').bind(JSON.stringify(st), id));
  }
  // Smart Auto runs after the rules (and also while rules are paused — it's a mode
  // you chose). It sees the AC as the rules left it, so "off at bedtime" ends it.
  const acNow = delivered ? { ...ac, ...change } : ac;
  for (const [kind, msg] of await runSmartAuto(env, tuya, deviceId, { ...ctx, ac: acNow })) logLine(kind, msg);

  if (!paused) {
    for (const n of result.notifications) {
      try {
        if (await sendNotification(settings, n.title, n.message)) logLine('notify', `${n.title}: ${n.message}`);
      } catch (e) {
        logLine('error', `Notification failed: ${e.message}`);
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  await kvSet(env, 'last_tick', { ts: now, calls: tuya.calls });
  return { ok: true, change, paused, commands: result.commands.length };
}

export async function getSmartAuto(env) {
  return { ...SMART_AUTO_DEFAULTS, state: {}, ...((await kvGet(env, 'smart_auto')) || {}) };
}

// One Smart Auto step: sends whatever it needs and saves its state. Returns log lines.
export async function runSmartAuto(env, tuya, deviceId, ctx) {
  const sa = await getSmartAuto(env);
  if (!sa.enabled) return [];
  const r = smartAutoStep(sa, sa.state || {}, ctx);
  const logs = [];
  if (r.disable) {
    await kvSet(env, 'smart_auto', { ...sa, enabled: false, state: {} });
    return [['rule', r.log]];
  }
  if (Object.keys(r.props).length) {
    try {
      await tuya.issue(deviceId, r.props);
      logs.push(['rule', `Smart Auto: ${describe(r.props)} (${r.reason})`]);
    } catch (e) {
      return [['error', `Smart Auto: sending ${describe(r.props)} failed: ${e.message}`]];
    }
  }
  await kvSet(env, 'smart_auto', { ...sa, state: r.state });
  return logs;
}

const MODE_NAMES = { cold: 'Cool', hot: 'Heat', wet: 'Dry', wind: 'Fan', auto: 'Auto' };
const FAN_NAMES = { 1: 'Auto', 2: 'Turbo', 3: 'Low', 4: 'Medium', 5: 'High' };
const BOOL_NAMES = {
  mode_ECO: 'Eco', mode_sleep: 'Sleep', heat: 'Aux heat', screen: 'Display', clean: 'Self-clean',
  wind_vertical: 'Swing ↕', wind_horizontal: 'Swing ↔', health: 'Health',
};

export function describe(p) {
  const parts = [];
  if (p.Power === false) return 'Turned off';
  if (p.Power === true) parts.push('Turned on');
  if (p.mode) parts.push(MODE_NAMES[p.mode] || p.mode);
  if (p.temp_set != null) parts.push(`${p.temp_set}°`);
  if (p.windspeed) parts.push(`fan ${FAN_NAMES[p.windspeed] || p.windspeed}`);
  for (const [k, n] of Object.entries(BOOL_NAMES)) if (k in p) parts.push(`${n} ${p[k] ? 'on' : 'off'}`);
  return parts.join(', ');
}

