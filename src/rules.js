// Pure rule evaluation. No I/O: takes the current world (ctx) and the rules,
// returns the commands to send, notifications, and each rule's new state.
//
// Rule kinds
//   schedule   – fires once at `at` (HH:MM) on the chosen days, if its conditions hold.
//   condition  – fires when its conditions *become* true (edge-triggered, so it
//                doesn't fight manual changes), inside an optional time window.
//   thermostat – while active, switches the AC on/off to hold `target` measured
//                by any sensor (the AC's own, a room sensor, or the sensor average).
//   warmup     – "ready by": switches on once a day, early enough for the room to reach
//                `target` by `at`, judged from the room and outside temperature and from
//                how fast it warmed up on earlier days (learned, per outside temperature).
//                It then leaves the AC on, so the unit holds the temperature itself.

import { actionProps } from './ac.js';

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localTime(now, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'Europe/London', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { dow: WEEKDAYS[parts.weekday], minutes, date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
}

export function hmToMin(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function dayOk(days, dow) {
  return !days || !days.length || days.includes(dow);
}

export function inWindow(local, days, window) {
  const from = hmToMin(window?.from);
  const to = hmToMin(window?.to);
  if (from == null || to == null || from === to) return dayOk(days, local.dow);
  const m = local.minutes;
  if (from < to) return dayOk(days, local.dow) && m >= from && m < to;
  // Overnight window (e.g. 22:00–07:00): the part after midnight belongs to the previous day.
  const prev = local.dow === 1 ? 7 : local.dow - 1;
  return (m >= from && dayOk(days, local.dow)) || (m < to && dayOk(days, prev));
}

export function resolveSource(src, ctx) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (src) {
    case 'room': return num(ctx.ac?.temp_current);
    case 'target': return num(ctx.ac?.temp_set);
    case 'ac_on': return ctx.ac && typeof ctx.ac.Power === 'boolean' ? (ctx.ac.Power ? 1 : 0) : null;
    case 'outside': return num(ctx.weather?.temp);
    case 'outside_feels': return num(ctx.weather?.feels);
    case 'outside_humidity': return num(ctx.weather?.humidity);
    case 'forecast_max': return num(ctx.weather?.todayMax);
    case 'forecast_min': return num(ctx.weather?.todayMin);
    case 'tonight_min': return tonightLow(ctx);
    case 'sensors_avg': {
      const vals = Object.values(ctx.sensors || {}).map((s) => num(s?.temp)).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    default:
      if (src?.startsWith('sensor:')) return num(ctx.sensors?.[src.slice(7)]?.temp);
      if (src?.startsWith('sensor_hum:')) return num(ctx.sensors?.[src.slice(11)]?.humidity);
      return null;
  }
}

// The lowest forecast temperature from now until the next `untilHm` (local time), from the
// hourly forecast. Hourly times are local ("2026-11-13T05:00"), so they compare as strings.
export function forecastLowUntil(ctx, untilHm) {
  const hourly = ctx.weather?.hourly;
  const local = ctx.local;
  const until = hmToMin(untilHm);
  if (!Array.isArray(hourly) || !hourly.length || !local?.date || until == null) return null;
  const hour = Math.floor(local.minutes / 60);
  const from = `${local.date}T${String(hour).padStart(2, '0')}:00`;
  let endDate = local.date;
  if (hour * 60 >= until) {
    const d = new Date(`${local.date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    endDate = d.toISOString().slice(0, 10);
  }
  const to = `${endDate}T${untilHm.padStart(5, '0')}`;
  const temps = hourly.filter((p) => p.t >= from && p.t <= to && typeof p.temp === 'number').map((p) => p.temp);
  return temps.length ? Math.min(...temps) : null;
}

// Tonight's low: the lowest forecast temperature from now until the next 08:00.
export const tonightLow = (ctx) => forecastLowUntil(ctx, '08:00');

// Warm-up speed in °C per minute (AC sensor), by outside temperature. Starting values
// come from an Electriq Easy-fit EIQ-9WMINV in a garden office (Oct–Nov 2026); each rule then
// learns its own.
export const WARMUP_BUCKETS = [
  ['lt0', -Infinity, 0], ['0-3', 0, 3], ['3-6', 3, 6], ['6-9', 6, 9], ['9-12', 9, 12], ['12+', 12, Infinity],
];
export const WARMUP_DEFAULT_RATES = { lt0: 0.05, '0-3': 0.06, '3-6': 0.09, '6-9': 0.14, '9-12': 0.22, '12+': 0.27 };

export function warmupBucket(outside) {
  if (typeof outside !== 'number') return '0-3'; // no weather: assume it's cold
  return WARMUP_BUCKETS.find(([, lo, hi]) => outside >= lo && outside < hi)[0];
}

// Minutes the room needs to get from `room` to `target`.
export function warmupMinutes(room, outside, target, rates = {}) {
  const key = warmupBucket(outside);
  const rate = rates[key] || WARMUP_DEFAULT_RATES[key];
  return Math.max(0, Math.ceil((target - room) / rate));
}

// true / false / undefined (= can't tell, e.g. weather or a sensor is unavailable)
export function evalCondition(c, ctx) {
  const left = resolveSource(c.src, ctx);
  let right;
  if (c.cmp) {
    const r = resolveSource(c.cmp, ctx);
    right = r == null ? null : r + (Number(c.offset) || 0);
  } else right = Number(c.value);
  if (left == null || right == null || !Number.isFinite(right)) return undefined;
  switch (c.op) {
    case '>': return left > right;
    case '>=': return left >= right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '=': return left === right;
    default: return undefined;
  }
}

export function evalConditions(list, ctx) {
  let unknown = false;
  for (const c of list || []) {
    const r = evalCondition(c, ctx);
    if (r === false) return false;
    if (r === undefined) unknown = true;
  }
  return unknown ? undefined : true;
}

function clampTemp(t) {
  return Math.min(32, Math.max(16, Math.round(t)));
}

export function evaluateRules(rules, ctx) {
  const { now, local } = ctx;
  const commands = [];
  const notifications = [];
  const states = new Map();
  const logs = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const def = rule.def;
    const st = { ...(rule.state || {}) };
    const fire = (props, reason) => {
      if (Object.keys(props).length) commands.push({ ruleId: rule.id, name: rule.name, props, reason });
    };
    const notify = (reason) => {
      if (def.notify) notifications.push({ title: rule.name, message: def.notify, reason });
    };

    if (def.kind === 'schedule') {
      const at = hmToMin(def.at);
      const late = at == null ? -1 : local.minutes - at;
      if (dayOk(def.days, local.dow) && late >= 0 && late < 60 && st.lastDate !== local.date) {
        st.lastDate = local.date;
        const cond = evalConditions(def.conditions, ctx);
        if (cond === true) {
          st.lastFired = now;
          fire(actionProps(def.action), `scheduled ${def.at}`);
          notify(`scheduled ${def.at}`);
        } else {
          logs.push(`${rule.name}: skipped at ${def.at} (${cond === false ? 'conditions not met' : 'data unavailable'})`);
        }
      }
    } else if (def.kind === 'condition') {
      if (!inWindow(local, def.days, def.window)) {
        st.lastCond = false;
      } else {
        const cond = evalConditions(def.conditions, ctx);
        if (cond !== undefined) {
          const cooldown = (Number(def.cooldownMin) || 0) * 60_000;
          if (cond && !st.lastCond && now - (st.lastFired || 0) >= cooldown) {
            st.lastFired = now;
            fire(actionProps(def.action), 'conditions met');
            notify('conditions met');
          }
          st.lastCond = cond;
        }
      }
    } else if (def.kind === 'warmup') {
      const w = def.warmup || {};
      const at = hmToMin(w.at);
      const target = Number(w.target);
      const earliest = hmToMin(w.earliest) ?? (at == null ? null : at - 180);
      const margin = Number(w.marginMin ?? 15) || 0;
      const room = resolveSource('room', ctx);
      // Judge by the colder of now and the forecast until the ready-by time: a frost
      // that's still coming slows the warm-up (defrosting) just as much as one now.
      const outsideNow = resolveSource('outside', ctx);
      const ahead = forecastLowUntil(ctx, w.at);
      const outside = outsideNow == null ? ahead : ahead == null ? outsideNow : Math.min(outsideNow, ahead);
      const m = local.minutes;
      st.rates ||= {};
      if (st.date !== local.date) Object.assign(st, { date: local.date, started: null, done: false });

      // Learn from today's warm-up: once the room is there (or an hour after the deadline).
      if (st.started && !st.done && room != null && (room >= target - 0.5 || m >= at + 60)) {
        const mins = (now - st.started.ts) / 60_000;
        const rise = room - st.started.room;
        if (mins >= 15 && rise >= 1) {
          const key = warmupBucket(st.started.outside);
          const rate = rise / mins;
          const old = st.rates[key];
          st.rates[key] = Math.round((old ? old * 0.6 + rate * 0.4 : rate) * 10000) / 10000;
          logs.push(`${rule.name}: warmed ${st.started.room}° → ${room}° in ${Math.round(mins)} min with ${st.started.outside ?? '?'}° outside — will use this next time`);
        }
        st.done = true;
      }

      if (!st.started && at != null && Number.isFinite(target) && dayOk(def.days, local.dow) &&
          m >= earliest && m < at + 60 && evalConditions(def.conditions, ctx) !== false) {
        const need = room == null ? 90 : warmupMinutes(room, outside, target, st.rates) + margin;
        const alreadyWarm = room != null && room >= target - 0.5;
        if (m >= at || (!alreadyWarm && m >= at - need)) {
          const mode = w.mode === 'cold' ? 'cold' : 'hot';
          fire({ Power: true, mode, temp_set: clampTemp(target), ...(w.fan ? { windspeed: String(w.fan) } : {}) },
            m >= at ? `ready by ${w.at}` : `ready by ${w.at}: about ${need} min needed (room ${room}°, outside ${outsideNow ?? '?'}°${ahead != null ? `, forecast low to ${w.at} ${ahead}°` : ''})`);
          notify(`ready by ${w.at}`);
          st.started = { ts: now, room, outside };
        }
      }
    } else if (def.kind === 'thermostat') {
      const th = def.thermostat || {};
      const target = Number(th.target);
      const band = Math.max(0.2, Number(th.band) || 0.5);
      const offset = Number(th.offset ?? 1);
      const minCycle = (Number(th.minCycleMin ?? 6) || 0) * 60_000;
      const active = inWindow(local, def.days, def.window) && evalConditions(def.conditions, ctx) !== false;
      const acOn = ctx.ac?.Power === true;

      if (!active) {
        if (st.active && st.running && acOn && th.offAtEnd !== false) {
          fire({ Power: false }, 'thermostat window ended');
          st.lastSwitch = now;
        }
        states.set(rule.id, { active: false, running: false, standDown: false, lastSwitch: st.lastSwitch });
        continue;
      }
      const windowOpening = !st.active;
      st.active = true;

      // Someone switched it off while we were running it: stand down until the next window.
      if (st.running && !acOn) {
        st.running = false;
        st.standDown = true;
        logs.push(`${rule.name}: AC was switched off manually — thermostat paused until it's switched back on or its next window`);
      }
      // Switched back on (in cool/heat) after a manual off: resume control.
      if (st.standDown && acOn && (ctx.ac.mode === 'cold' || ctx.ac.mode === 'hot')) {
        st.standDown = false;
        logs.push(`${rule.name}: AC was switched back on — thermostat resumed`);
      }
      // Someone switched it on in cool/heat: adopt it, so we turn it off when satisfied.
      if (!st.running && acOn && !st.standDown && (ctx.ac.mode === 'cold' || ctx.ac.mode === 'hot')) {
        st.running = true;
        st.runMode = ctx.ac.mode;
        // Already on when the window opens (e.g. left at 16° by an overnight rule): take over
        // with the thermostat's own setpoint. A manual switch-on mid-window keeps the user's.
        if (windowOpening) {
          const set = clampTemp(ctx.ac.mode === 'hot' ? target + offset : target - offset);
          const want = { temp_set: set, ...(th.fan ? { windspeed: String(th.fan) } : {}) };
          const change = Object.fromEntries(Object.entries(want).filter(([k, v]) => ctx.ac[k] !== v));
          if (Object.keys(change).length) fire(change, `taking over at ${def.window?.from || 'start'}`);
        }
      }

      const t = resolveSource(th.sensor || 'room', ctx);
      const canSwitch = now - (st.lastSwitch || 0) >= minCycle;
      if (t != null && Number.isFinite(target) && !st.standDown && canSwitch) {
        const allowCool = th.mode === 'cold' || th.mode === 'auto' || !th.mode;
        const allowHeat = (th.mode === 'hot' || th.mode === 'auto') && ctx.caps?.heatPump !== false;
        const fan = th.fan ? { windspeed: String(th.fan) } : {};
        if (!acOn) {
          if (allowCool && t >= target + band) {
            fire({ Power: true, mode: 'cold', temp_set: clampTemp(target - offset), ...fan }, `${t.toFixed(1)}° ≥ ${target + band}°`);
            Object.assign(st, { running: true, runMode: 'cold', lastSwitch: now });
          } else if (allowHeat && t <= target - band) {
            fire({ Power: true, mode: 'hot', temp_set: clampTemp(target + offset), ...fan }, `${t.toFixed(1)}° ≤ ${target - band}°`);
            Object.assign(st, { running: true, runMode: 'hot', lastSwitch: now });
          }
        } else if (st.running) {
          const done = st.runMode === 'hot' ? t >= target + band : t <= target - band;
          if (done) {
            fire({ Power: false }, `${t.toFixed(1)}° reached target ${target}°`);
            Object.assign(st, { running: false, lastSwitch: now });
          }
        }
      }
    }
    states.set(rule.id, st);
  }
  return { commands, notifications, states, logs };
}

// Later rules (lower in the list) win on conflicting properties.
export function mergeCommands(commands) {
  const merged = {};
  for (const c of commands) Object.assign(merged, c.props);
  return merged.Power === false ? { Power: false } : merged;
}

// Smart Auto: the unit's own Auto mode is locked to 25°, so this keeps the AC on in
// Cool or Heat at the user's target, and flips between them when the room drifts
// `band` degrees past the target the other way. Switching the AC off or picking
// another mode (anywhere: app, remote, Smart Life) ends Smart Auto.
export const SMART_AUTO_DEFAULTS = { enabled: false, target: 22, sensor: 'room', band: 1, minSwitchMin: 15 };

export function smartAutoStep(cfg, st, ctx) {
  if (!cfg?.enabled) return { props: {}, state: {} };
  const { ac, now } = ctx;
  if (st.active && ac.Power === false) return { disable: true, log: 'Smart Auto stopped — the AC was switched off' };
  if (st.active && ac.Power && st.mode && ac.mode !== st.mode) {
    return { disable: true, log: `Smart Auto stopped — mode was changed to ${ac.mode}` };
  }
  const target = Number(cfg.target);
  const band = Number(cfg.band) || SMART_AUTO_DEFAULTS.band;
  const heatOk = ctx.caps?.heatPump !== false;
  const t = resolveSource(cfg.sensor || 'room', ctx);
  const canSwitch = now - (st.lastSwitch || 0) >= (cfg.minSwitchMin ?? SMART_AUTO_DEFAULTS.minSwitchMin) * 60_000;

  let mode = st.mode;
  if (!mode) mode = !heatOk || t == null || t >= target ? 'cold' : 'hot';
  else if (t != null && canSwitch) {
    if (mode === 'cold' && heatOk && t <= target - band) mode = 'hot';
    else if (mode === 'hot' && t >= target + band) mode = 'cold';
  }
  const setpoint = clampTemp(target);
  let props = {};
  let reason = '';
  if (!st.active || ac.Power !== true) {
    props = { Power: true, mode, temp_set: setpoint };
    reason = `started at ${target}°`;
  } else if (mode !== st.mode) {
    props = { mode, temp_set: setpoint };
    reason = `${t.toFixed(1)}° — switching to ${mode === 'hot' ? 'heating' : 'cooling'}`;
  }
  const switched = !st.active || mode !== st.mode;
  return { props, reason, state: { active: true, mode, lastSwitch: switched ? now : st.lastSwitch } };
}
