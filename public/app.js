// AC Control — front end. Plain JS, no build step.

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};

const MODES = [
  ['cold', 'Cool', '--cool'], ['hot', 'Heat', '--heat'], ['wet', 'Dry', '--dry'], ['wind', 'Fan', '--fan'], ['auto', 'Auto', '--auto'],
];
const FANS = [['1', 'Auto'], ['3', 'Low'], ['4', 'Med'], ['5', 'High'], ['2', 'Turbo']];
const TOGGLES = [
  ['wind_vertical', 'Swing up/down', '↕'], ['wind_horizontal', 'Swing sideways', '↔'], ['mode_ECO', 'Eco', '🌿'],
  ['mode_sleep', 'Sleep', '🌙'], ['screen', 'Display', '💡'], ['heat', 'Aux heat', '🔥'],
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEATHER = (c) =>
  c === 0 ? 'Clear' : c <= 2 ? 'Partly cloudy' : c === 3 ? 'Cloudy' : c <= 48 ? 'Fog' : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain'
    : c <= 77 ? 'Snow' : c <= 82 ? 'Showers' : c <= 86 ? 'Snow showers' : 'Thunderstorm';

let S = null; // last /api/state
let rules = [];
let tab = 'control';
let pendingTemp = null;
let tempTimer = null;
let range = 24;
let logKind = '';

// ---------- api ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Not signed in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = h('div', { class: `toast${err ? ' err' : ''}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), err ? 4500 : 2200);
}

const fmtT = (v, d = 0) => (typeof v === 'number' ? `${v.toFixed(d)}°` : '–');
const tz = () => S?.settings?.tz || 'Europe/London';
const fmtTime = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit' }).format(ts);
const fmtDay = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz(), weekday: 'short', day: 'numeric', month: 'short' }).format(ts);
function fmtWhen(ts) {
  const d = new Date(ts);
  const sameDay = new Intl.DateTimeFormat('en-GB', { timeZone: tz(), dateStyle: 'short' });
  return sameDay.format(d) === sameDay.format(new Date()) ? fmtTime(ts) : `${fmtDay(ts)} ${fmtTime(ts)}`;
}

// ---------- control ----------

// Tuya's cloud can report the old value for a little while after a command, so
// keep showing what was just sent for up to 20 s unless the AC confirms it sooner.
const recent = {};

async function loadState() {
  try {
    S = await api('/api/state');
    const now = Date.now();
    for (const [code, r] of Object.entries(recent)) {
      if (r.until < now || S.ac[code] === r.value) delete recent[code];
      else S.ac[code] = r.value;
    }
    renderControl();
  } catch (e) {
    $('#status-text').textContent = e.message;
    $('#online-dot').className = 'dot off';
  }
}

async function send(props, optimistic = true) {
  if (optimistic && S) {
    Object.assign(S.ac, props);
    renderControl();
  }
  try {
    await api('/api/command', { method: 'POST', body: { props } });
    for (const [code, value] of Object.entries(props)) recent[code] = { value, until: Date.now() + 20_000 };
  } catch (e) {
    toast(`Not sent: ${e.message}`, true);
    for (const code of Object.keys(props)) delete recent[code];
  }
  setTimeout(loadState, 2500);
}

function modeVar(mode) {
  return (MODES.find((m) => m[0] === mode) || MODES[0])[2];
}

function renderControl() {
  const ac = S.ac;
  const on = ac.Power === true;
  const sa = S.smartAuto || {};
  const smart = !!sa.enabled;
  document.documentElement.style.setProperty('--mode', smart ? 'var(--smart)' : `var(${modeVar(ac.mode)})`);
  $('#title').textContent = S.settings.name || 'Air conditioner';
  document.title = S.settings.name || 'AC Control';
  const online = S.online;
  $('#online-dot').className = `dot ${online === false ? 'off' : on ? 'on' : ''}`;
  $('#status-text').textContent = online === false ? 'Offline'
    : on && smart ? `On · Smart Auto (${ac.mode === 'hot' ? 'heating' : 'cooling'})`
    : on ? `On · ${MODES.find((m) => m[0] === ac.mode)?.[1] || ''}` : 'Off';

  $('#hero').classList.toggle('is-off', !on);
  $('#room-temp').innerHTML = typeof ac.temp_current === 'number' ? `${ac.temp_current}<sup>°C</sup>` : '–';
  $('#power').classList.toggle('on', on);

  const w = S.weather;
  const out = $('#outside');
  out.innerHTML = '';
  if (w) {
    out.append('Outside ', h('b', {}, fmtT(w.temp)), ` · feels ${fmtT(w.feels)} · ${WEATHER(w.code)} · today ${fmtT(w.todayMin)}–${fmtT(w.todayMax)}`);
  } else {
    out.append('Set your location in Settings to see the outside temperature.');
  }

  const nativeAuto = !smart && ac.mode === 'auto';
  const target = pendingTemp ?? (smart ? sa.target : ac.temp_set);
  const maxT = smart ? 30 : 32;
  $('#target-label').textContent = smart ? 'Smart Auto' : 'Target';
  $('#target').textContent = fmtT(target);
  $('#temp-down').disabled = nativeAuto || !(target > 16);
  $('#temp-up').disabled = nativeAuto || !(target < maxT);
  const note = $('#target-note');
  note.hidden = !(smart || nativeAuto);
  note.innerHTML = '';
  if (nativeAuto) {
    note.append('The unit fixes its own Auto mode at 25°. Choose Smart for your own temperature.');
  } else if (smart) {
    const band = sa.band || 1;
    const heating = ac.mode === 'hot';
    const heatOk = !(S.caps && S.caps.heatPump === false);
    // The AC's own sensor reports whole degrees, so show where the switch really happens.
    const whole = (sa.sensor || 'room') === 'room';
    const up = whole ? `${Math.ceil(target + band)}°` : fmtT(target + band, 1);
    const down = whole ? `${Math.floor(target - band)}°` : fmtT(target - band, 1);
    note.append(heating
      ? `Heating now — switches to cooling at ${up} or warmer.`
      : heatOk ? `Cooling now — switches to heating at ${down} or cooler.` : 'Cooling to your target.');
    const opts = [['room', 'AC sensor']];
    if (S.sensors.length > 1) opts.push(['sensors_avg', 'Average of sensors']);
    for (const x of S.sensors) opts.push([`sensor:${x.id}`, x.name]);
    if (opts.length > 1) {
      const sel = h('select', { 'aria-label': 'Sensor to follow', onchange: (e) => smartAuto({ sensor: e.target.value }) });
      for (const [v, l] of opts) sel.append(h('option', { value: v, selected: v === sa.sensor }, `Follow: ${l}`));
      note.append(sel);
    }
  }

  const modes = $('#modes');
  modes.innerHTML = '';
  for (const [code, label] of MODES) {
    if (code === 'hot' && S.caps && S.caps.heatPump === false) continue;
    modes.append(h('button', {
      class: !smart && ac.mode === code ? 'sel' : '',
      onclick: async () => {
        if (smart) await smartAuto({ enabled: false }, false);
        send(on ? { mode: code } : { Power: true, mode: code });
      },
    }, label));
  }
  modes.append(h('button', {
    class: smart ? 'sel' : '', title: 'Auto at your own temperature',
    onclick: () => { if (!smart) smartAuto({ enabled: true }); },
  }, 'Smart'));
  const fans = $('#fans');
  fans.innerHTML = '';
  for (const [code, label] of FANS) fans.append(h('button', { class: ac.windspeed === code ? 'sel' : '', onclick: () => send({ windspeed: code }) }, label));

  const tg = $('#toggles');
  tg.innerHTML = '';
  for (const [code, label, ico] of TOGGLES) {
    if (code === 'heat' && S.caps && S.caps.auxHeater === false) continue;
    tg.append(h('button', { class: `tog${ac[code] ? ' on' : ''}`, onclick: () => send({ [code]: !ac[code] }) }, h('span', { class: 'ico' }, ico), label));
  }

  // Banners
  const b = $('#banners');
  b.innerHTML = '';
  if (S.faults?.length) b.append(h('div', { class: 'banner bad' }, `⚠️ The AC reports fault code${S.faults.length > 1 ? 's' : ''} ${S.faults.join(', ')}. Check the unit's manual.`));
  if (on && ac.mode === 'cold' && w && typeof ac.temp_current === 'number' && w.temp < ac.temp_current - 2) {
    b.append(h('div', { class: 'banner info' }, `🪟 It's ${fmtT(w.temp)} outside — cooler than inside. Opening a window may be enough.`));
  }

  // Sensors
  const sl = $('#sensor-list');
  sl.innerHTML = '';
  $('#sensors-card').hidden = !S.sensors.length;
  for (const s of S.sensors) {
    sl.append(h('div', { class: 'sensor' }, h('div', { class: 'n' }, s.name), h('div', { class: 't' }, fmtT(s.temp, 1)),
      h('div', { class: 'small muted' }, [s.humidity != null ? `${Math.round(s.humidity)}% RH` : '', s.ts ? ` · ${fmtWhen(s.ts)}` : ''].join(''))));
  }

  // Automations / pause
  const paused = S.settings.pauseUntil > S.now;
  $('#auto-status').textContent = paused ? `Paused until ${fmtWhen(S.settings.pauseUntil)}` : S.lastTick ? `Last check ${fmtWhen(S.lastTick.ts)}` : 'Waiting for first check';
  const pb = $('#pause-btns');
  pb.innerHTML = '';
  if (paused) pb.append(h('button', { class: 'btn small primary', onclick: () => pause(0) }, 'Resume'));
  else {
    pb.append(h('button', { class: 'btn small', onclick: () => pause(60) }, 'Pause 1 h'));
    pb.append(h('button', { class: 'btn small', onclick: () => pause(180) }, '3 h'));
  }
}

async function pause(minutes) {
  try {
    const s = await api('/api/pause', { method: 'POST', body: { minutes } });
    S.settings = s;
    S.now = Date.now();
    renderControl();
  } catch (e) {
    toast(e.message, true);
  }
}

function stepTemp(d) {
  if (!S) return;
  const smart = !!S.smartAuto?.enabled;
  const base = pendingTemp ?? (smart ? S.smartAuto.target : S.ac.temp_set) ?? 22;
  pendingTemp = Math.min(smart ? 30 : 32, Math.max(16, base + d));
  renderControl();
  clearTimeout(tempTimer);
  tempTimer = setTimeout(() => {
    const v = pendingTemp;
    pendingTemp = null;
    if (smart) smartAuto({ target: v });
    else send({ temp_set: v });
  }, 700);
}

$('#power').onclick = async () => {
  if (!S) return;
  if (S.ac.Power && S.smartAuto?.enabled) await smartAuto({ enabled: false }, false);
  send({ Power: !S.ac.Power });
};

async function smartAuto(patch, refresh = true) {
  S.smartAuto = { ...S.smartAuto, ...patch };
  if (patch.enabled) S.ac.Power = true;
  renderControl();
  try {
    S.smartAuto = await api('/api/smart-auto', { method: 'POST', body: patch });
  } catch (e) {
    toast(e.message, true);
  }
  if (refresh) setTimeout(loadState, 2500);
}
$('#temp-down').onclick = () => stepTemp(-1);
$('#temp-up').onclick = () => stepTemp(1);

// ---------- rules ----------

function sourceOptions() {
  const opts = [
    ['room', 'Room temp (AC sensor)'],
    ['outside', 'Outside temp'],
    ['outside_feels', 'Outside feels-like'],
    ['forecast_max', "Today's forecast high"],
    ['forecast_min', "Today's forecast low"],
    ['outside_humidity', 'Outside humidity %'],
    ['target', 'AC target temp'],
    ['ac_on', 'AC is on (1 = on, 0 = off)'],
  ];
  const sensors = S?.sensors || [];
  if (sensors.length > 1) opts.splice(1, 0, ['sensors_avg', 'Average of all sensors']);
  for (const s of sensors) {
    opts.splice(1, 0, [`sensor:${s.id}`, `${s.name} temp`]);
    opts.push([`sensor_hum:${s.id}`, `${s.name} humidity %`]);
  }
  return opts;
}
const sourceLabel = (src) => (sourceOptions().find((o) => o[0] === src)?.[1] || src).replace(/ \(.*\)$/, '');

function describeAction(a = {}) {
  if (a.power === 'off') return 'turn off';
  const p = [];
  if (a.power === 'on') p.push('turn on');
  if (a.mode) p.push(MODES.find((m) => m[0] === a.mode)?.[1].toLowerCase());
  if (a.temp != null) p.push(`${a.temp}°`);
  if (a.fan) p.push(`fan ${FANS.find((f) => f[0] === a.fan)?.[1].toLowerCase()}`);
  const t = { swingV: 'swing ↕', swingH: 'swing ↔', eco: 'eco', sleep: 'sleep', screen: 'display', heat: 'aux heat' };
  for (const [k, n] of Object.entries(t)) if (typeof a[k] === 'boolean') p.push(`${n} ${a[k] ? 'on' : 'off'}`);
  return p.join(', ');
}
function describeCond(c) {
  const rhs = c.cmp ? `${sourceLabel(c.cmp)}${c.offset ? ` ${c.offset > 0 ? '+' : '−'} ${Math.abs(c.offset)}°` : ''}` : c.src === 'ac_on' ? (c.value ? 'on' : 'off') : `${c.value}`;
  if (c.src === 'ac_on') return `AC is ${rhs}`;
  return `${sourceLabel(c.src)} ${c.op} ${rhs}`;
}
function describeDays(days) {
  if (!days?.length || days.length === 7) return 'every day';
  if (days.join() === '1,2,3,4,5') return 'weekdays';
  if (days.join() === '6,7') return 'weekends';
  return days.map((d) => DAYS[d - 1]).join(', ');
}
function summarize(def) {
  const conds = def.conditions?.length ? ` if ${def.conditions.map(describeCond).join(' and ')}` : '';
  const win = def.window ? ` between ${def.window.from}–${def.window.to}` : '';
  if (def.kind === 'schedule') {
    return `At ${def.at}, ${describeDays(def.days)}${conds}: ${[describeAction(def.action), def.notify && 'notify'].filter(Boolean).join(' + ')}`;
  }
  if (def.kind === 'condition') {
    return `When${conds.replace(/^ if/, '')}${win}, ${describeDays(def.days)}: ${[describeAction(def.action), def.notify && 'notify'].filter(Boolean).join(' + ')}`;
  }
  const th = def.thermostat;
  const mode = { cold: 'cool', hot: 'heat', auto: 'cool/heat' }[th.mode];
  return `Hold ${th.target}° (±${th.band}) by ${sourceLabel(th.sensor)}, ${mode}${win || ' all day'}, ${describeDays(def.days)}${conds}`;
}

async function loadRules() {
  try {
    rules = await api('/api/rules');
  } catch (e) {
    toast(e.message, true);
  }
  renderRules();
}

function renderRules() {
  const list = $('#rule-list');
  list.innerHTML = '';
  if (!rules.length) {
    list.append(h('div', { class: 'empty' }, 'No rules yet. Tap “New rule” to start from a template.'));
    return;
  }
  rules.forEach((r, i) => {
    const sw = h('label', { class: 'switch' }, h('input', {
      type: 'checkbox', checked: r.enabled,
      onchange: async (e) => {
        try {
          await api(`/api/rules/${r.id}`, { method: 'PUT', body: { enabled: e.target.checked } });
          r.enabled = e.target.checked;
          renderRules();
        } catch (err) {
          toast(err.message, true);
          e.target.checked = !e.target.checked;
        }
      },
    }), h('span'));
    const order = h('div', { class: 'order' },
      h('button', { 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '▲'),
      h('button', { 'aria-label': 'Move down', disabled: i === rules.length - 1, onclick: () => move(i, 1) }, '▼'));
    const kind = { schedule: 'Schedule', condition: 'When…', thermostat: 'Thermostat' }[r.def.kind];
    list.append(h('div', { class: `rule${r.enabled ? '' : ' disabled'}` }, order,
      h('div', { class: 'body', onclick: () => openRule(r), style: 'cursor:pointer' },
        h('div', { class: 'kind' }, kind), h('div', { class: 'name' }, r.name), h('div', { class: 'sum' }, summarize(r.def))),
      sw));
  });
}

async function move(i, d) {
  const j = i + d;
  [rules[i], rules[j]] = [rules[j], rules[i]];
  renderRules();
  try {
    await api('/api/rules/order', { method: 'POST', body: { ids: rules.map((r) => r.id) } });
  } catch (e) {
    toast(e.message, true);
  }
}

const TEMPLATES = [
  {
    title: 'Pre-cool on hot days', desc: 'At 14:00, if the forecast high is over 26°, start cooling to 23°.',
    rule: { name: 'Pre-cool on hot days', def: { kind: 'schedule', at: '14:00', days: [], conditions: [{ src: 'forecast_max', op: '>', value: 26 }], action: { power: 'on', mode: 'cold', temp: 23, fan: '1' }, notify: '' } },
  },
  {
    title: 'Night thermostat', desc: 'From 22:00 to 07:00, hold 21° with a quiet fan, then switch off.',
    rule: { name: 'Night thermostat', def: { kind: 'thermostat', days: [], window: { from: '22:00', to: '07:00' }, conditions: [], thermostat: { target: 21, band: 0.5, sensor: 'room', mode: 'cold', fan: '3', offset: 1, minCycleMin: 6, offAtEnd: true } } },
  },
  {
    title: 'Open-window alert', desc: 'Notify me when it’s 2° cooler outside than inside while the AC is cooling.',
    rule: { name: 'Open-window alert', def: { kind: 'condition', days: [], window: null, conditions: [{ src: 'outside', op: '<', cmp: 'room', offset: -2 }, { src: 'ac_on', op: '=', value: 1 }], action: {}, notify: 'It’s cooler outside than inside — open a window and switch the AC off?', cooldownMin: 180 } },
  },
  {
    title: 'Too hot → cool', desc: 'When the room goes above 26° (09:00–23:00), cool to 23°.',
    rule: { name: 'Too hot', def: { kind: 'condition', days: [], window: { from: '09:00', to: '23:00' }, conditions: [{ src: 'room', op: '>', value: 26 }], action: { power: 'on', mode: 'cold', temp: 23 }, notify: '', cooldownMin: 60 } },
  },
  {
    title: 'Off at bedtime', desc: 'Every day at 23:30, switch off.',
    rule: { name: 'Off at bedtime', def: { kind: 'schedule', at: '23:30', days: [], conditions: [], action: { power: 'off' }, notify: '' } },
  },
  { title: 'Blank schedule', desc: 'Do something at a set time.', rule: { name: '', def: { kind: 'schedule', at: '08:00', days: [], conditions: [], action: {}, notify: '' } } },
  { title: 'Blank “when…” rule', desc: 'Do something when readings cross a threshold.', rule: { name: '', def: { kind: 'condition', days: [], window: null, conditions: [{ src: 'room', op: '>', value: 25 }], action: {}, notify: '', cooldownMin: 30 } } },
  { title: 'Blank thermostat', desc: 'Hold a temperature using any sensor.', rule: { name: '', def: { kind: 'thermostat', days: [], window: null, conditions: [], thermostat: { target: 22, band: 0.5, sensor: 'room', mode: 'cold', fan: null, offset: 1, minCycleMin: 6, offAtEnd: true } } } },
];

const dialog = $('#rule-dialog');
let editing = null; // { id?, name, enabled, def }

$('#new-rule').onclick = () => {
  editing = null;
  $('#rule-title').textContent = 'New rule';
  $('#rule-save').hidden = true;
  const body = $('#rule-body');
  body.innerHTML = '';
  body.append(h('p', { class: 'small muted' }, 'Start from a template — you can change everything on the next screen.'));
  const list = h('div', { class: 'templates' });
  for (const t of TEMPLATES) list.append(h('button', { class: 'template', onclick: () => openRule(structuredClone(t.rule)) }, h('b', {}, t.title), h('span', {}, t.desc)));
  body.append(list);
  dialog.showModal();
};
$('#rule-cancel').onclick = () => dialog.close();

function openRule(r) {
  editing = structuredClone({ enabled: true, ...r });
  const def = editing.def;
  def.conditions ||= [];
  def.days ||= [];
  if (def.kind !== 'thermostat') def.action ||= {};
  $('#rule-title').textContent = r.id ? 'Edit rule' : 'New rule';
  $('#rule-save').hidden = false;
  renderEditor();
  if (!dialog.open) dialog.showModal();
}

function select(options, value, onchange, attrs = {}) {
  const s = h('select', { ...attrs, onchange: (e) => onchange(e.target.value) });
  for (const [v, label] of options) s.append(h('option', { value: v, selected: String(v) === String(value ?? '') }, label));
  return s;
}
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint && h('div', { class: 'small muted', style: 'margin-top:4px' }, hint));

function renderEditor() {
  const def = editing.def;
  const body = $('#rule-body');
  body.innerHTML = '';

  body.append(field('Name', h('input', { type: 'text', value: editing.name || '', maxlength: 80, placeholder: 'e.g. Cool the bedroom', oninput: (e) => (editing.name = e.target.value) })));

  const kinds = h('div', { class: 'seg' });
  for (const [k, label] of [['schedule', 'At a time'], ['condition', 'When…'], ['thermostat', 'Thermostat']]) {
    kinds.append(h('button', {
      type: 'button', class: def.kind === k ? 'sel' : '',
      onclick: () => {
        def.kind = k;
        if (k === 'schedule') def.at ||= '08:00';
        if (k === 'thermostat') def.thermostat ||= { target: 22, band: 0.5, sensor: 'room', mode: 'cold', fan: null, offset: 1, minCycleMin: 6, offAtEnd: true };
        else def.action ||= {};
        if (k === 'condition') def.cooldownMin ??= 30;
        renderEditor();
      },
    }, label));
  }
  body.append(h('div', { class: 'field' }, h('span', { class: 'small muted', style: 'display:block;margin-bottom:5px' }, 'Type'), kinds));

  // Days
  const days = h('div', { class: 'days' });
  DAYS.forEach((d, i) => {
    const n = i + 1;
    days.append(h('button', {
      type: 'button', class: def.days.includes(n) ? 'sel' : '',
      onclick: () => {
        def.days = def.days.includes(n) ? def.days.filter((x) => x !== n) : [...def.days, n].sort();
        renderEditor();
      },
    }, d[0] + d[1]));
  });
  body.append(field('Days', days, def.days.length ? describeDays(def.days) : 'None selected = every day'));

  // When
  if (def.kind === 'schedule') {
    body.append(field('Time', h('input', { type: 'time', value: def.at || '', oninput: (e) => (def.at = e.target.value) })));
  } else {
    const all = !def.window;
    const winBox = h('div', { class: 'inline', hidden: all },
      h('input', { type: 'time', value: def.window?.from || '09:00', oninput: (e) => (def.window.from = e.target.value) }),
      h('span', { class: 'shrink muted' }, 'to'),
      h('input', { type: 'time', value: def.window?.to || '17:00', oninput: (e) => (def.window.to = e.target.value) }));
    body.append(h('div', { class: 'field' },
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: all,
        onchange: (e) => {
          def.window = e.target.checked ? null : { from: '09:00', to: '17:00' };
          renderEditor();
        },
      }), 'All day'),
      winBox,
      !all && h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Overnight windows like 22:00–07:00 work too.')));
  }

  // Conditions
  const condWrap = h('div', { class: 'field' }, h('span', { class: 'small muted', style: 'display:block' },
    def.kind === 'condition' ? 'When all of these are true' : def.kind === 'schedule' ? 'Only if (optional)' : 'Only active while (optional)'));
  def.conditions.forEach((c, i) => condWrap.append(condRow(c, i)));
  condWrap.append(h('button', { type: 'button', class: 'btn small', onclick: () => { def.conditions.push({ src: 'outside', op: '>', value: 20 }); renderEditor(); } }, '+ Add condition'));
  body.append(condWrap);

  if (def.kind === 'thermostat') body.append(thermostatFields(def.thermostat));
  else body.append(actionFields(def));

  if (def.kind === 'condition') {
    body.append(field('Wait at least (minutes) before firing again', h('input', { type: 'number', min: 0, max: 1440, value: def.cooldownMin ?? 30, oninput: (e) => (def.cooldownMin = Number(e.target.value)) }),
      'Fires once each time the conditions become true — it won’t keep overriding your manual changes.'));
  }

  if (editing.id) {
    body.append(h('div', { style: 'margin-top:24px' }, h('button', {
      type: 'button', class: 'btn danger',
      onclick: async () => {
        if (!confirm(`Delete “${editing.name}”?`)) return;
        try {
          await api(`/api/rules/${editing.id}`, { method: 'DELETE' });
          dialog.close();
          loadRules();
        } catch (e) {
          toast(e.message, true);
        }
      },
    }, 'Delete rule')));
  }
}

function condRow(c, i) {
  const def = editing.def;
  const isAcOn = c.src === 'ac_on';
  const compareMode = c.cmp ? 'source' : 'number';
  const row = h('div', { class: 'cond' });
  row.append(h('div', { class: 'inline' },
    select(sourceOptions(), c.src, (v) => {
      c.src = v;
      if (v === 'ac_on') { c.op = '='; c.value = 1; delete c.cmp; delete c.offset; }
      renderEditor();
    }),
    h('button', { type: 'button', class: 'btn small shrink', 'aria-label': 'Remove', onclick: () => { def.conditions.splice(i, 1); renderEditor(); } }, '✕')));
  if (isAcOn) {
    row.append(select([['1', 'is on'], ['0', 'is off']], c.value, (v) => (c.value = Number(v))));
    return row;
  }
  const rhs = h('div', { class: 'inline' },
    select([['>', 'is above'], ['>=', 'is at least'], ['<', 'is below'], ['<=', 'is at most']], c.op, (v) => (c.op = v), { class: 'shrink', style: 'width:auto' }));
  if (compareMode === 'number') {
    rhs.append(h('input', { type: 'number', step: '0.5', value: c.value ?? '', oninput: (e) => (c.value = e.target.value === '' ? '' : Number(e.target.value)) }));
  } else {
    rhs.append(select(sourceOptions().filter((o) => o[0] !== 'ac_on'), c.cmp, (v) => (c.cmp = v)));
    rhs.append(h('input', { type: 'number', step: '0.5', class: 'shrink', style: 'width:72px', value: c.offset ?? 0, title: '± degrees', oninput: (e) => (c.offset = Number(e.target.value) || 0) }));
  }
  row.append(rhs);
  row.append(select([['number', 'Compare to a number'], ['source', 'Compare to another reading (± offset)']], compareMode, (v) => {
    if (v === 'source') { c.cmp = 'room'; c.offset = 0; delete c.value; } else { delete c.cmp; delete c.offset; c.value = 20; }
    renderEditor();
  }));
  return row;
}

function actionFields(def) {
  const a = def.action;
  const wrap = h('div', { class: 'card', style: 'margin:16px 0 0' }, h('h2', {}, 'Then'));
  const set = (k, v) => { if (v === '' || v == null) delete a[k]; else a[k] = v; };
  wrap.append(field('Power', select([['', 'Leave as is'], ['on', 'Turn on'], ['off', 'Turn off']], a.power || '', (v) => { set('power', v); renderEditor(); })));
  if (a.power !== 'off') {
    wrap.append(field('Mode', select([['', 'Leave as is'], ...MODES.map((m) => [m[0], m[1]])], a.mode || '', (v) => set('mode', v))));
    wrap.append(field('Target temperature', h('input', { type: 'number', min: 16, max: 32, step: 1, placeholder: 'Leave as is', value: a.temp ?? '', oninput: (e) => set('temp', e.target.value === '' ? '' : Number(e.target.value)) })));
    wrap.append(field('Fan', select([['', 'Leave as is'], ...FANS], a.fan || '', (v) => set('fan', v))));
    const tri = (k, label) => field(label, select([['', 'Leave as is'], ['true', 'On'], ['false', 'Off']], a[k] === undefined ? '' : String(a[k]), (v) => set(k, v === '' ? '' : v === 'true')));
    const grid = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 10px' },
      tri('swingV', 'Swing ↕'), tri('swingH', 'Swing ↔'), tri('eco', 'Eco'), tri('sleep', 'Sleep'), tri('screen', 'Display'));
    wrap.append(grid);
  }
  wrap.append(field('Also notify me (optional)', h('input', { type: 'text', maxlength: 200, placeholder: 'Message — needs ntfy set up in Settings', value: def.notify || '', oninput: (e) => (def.notify = e.target.value) })));
  return wrap;
}

function thermostatFields(th) {
  const wrap = h('div', { class: 'card', style: 'margin:16px 0 0' }, h('h2', {}, 'Thermostat'));
  const sensors = sourceOptions().filter((o) => o[0] === 'room' || o[0] === 'sensors_avg' || o[0].startsWith('sensor:'));
  wrap.append(field('Keep this reading…', select(sensors, th.sensor, (v) => (th.sensor = v)), 'Using a sensor away from the AC usually gives a more even room temperature.'));
  wrap.append(h('div', { class: 'inline' },
    field('…at (°C)', h('input', { type: 'number', min: 10, max: 35, step: 0.5, value: th.target, oninput: (e) => (th.target = Number(e.target.value)) })),
    field('± band', h('input', { type: 'number', min: 0.2, max: 3, step: 0.1, value: th.band, oninput: (e) => (th.band = Number(e.target.value)) }))));
  const modes = [['cold', 'Cool only'], ['auto', 'Cool or heat']];
  if (S?.caps?.heatPump !== false) modes.splice(1, 0, ['hot', 'Heat only']);
  else if (th.mode !== 'cold') th.mode = 'cold';
  wrap.append(field('Mode', select(modes, th.mode, (v) => (th.mode = v))));
  wrap.append(field('Fan while running', select([['', 'Leave as is'], ...FANS], th.fan || '', (v) => (th.fan = v || null))));
  wrap.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: th.offAtEnd !== false, onchange: (e) => (th.offAtEnd = e.target.checked) }), 'Switch off when the time window ends'));
  wrap.append(h('details', {},
    h('summary', { class: 'small muted', style: 'margin:10px 0' }, 'Advanced'),
    field('AC setpoint offset (°)', h('input', { type: 'number', min: 0, max: 4, step: 0.5, value: th.offset ?? 1, oninput: (e) => (th.offset = Number(e.target.value)) }),
      'When cooling, the AC is set this many degrees below your target so it keeps working until your sensor is satisfied.'),
    field('Minimum minutes between on/off', h('input', { type: 'number', min: 0, max: 60, value: th.minCycleMin ?? 6, oninput: (e) => (th.minCycleMin = Number(e.target.value)) }), 'Protects the compressor from rapid cycling.')));
  wrap.append(h('p', { class: 'small muted', style: 'margin-bottom:0' }, 'The thermostat switches the AC on above target + band and off below target − band. If you switch the AC off yourself, it stays off until the next window.'));
  return wrap;
}

$('#rule-save').onclick = async () => {
  const btn = $('#rule-save');
  btn.disabled = true;
  try {
    if (editing.id) await api(`/api/rules/${editing.id}`, { method: 'PUT', body: editing });
    else await api('/api/rules', { method: 'POST', body: editing });
    dialog.close();
    toast('Rule saved');
    loadRules();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
};

// ---------- history ----------

const SERIES_COLORS = ['#1d8fe1', '#ef6c1a', '#16a34a', '#a855f7', '#e11d48', '#0891b2'];

async function loadHistory() {
  const rs = $('#ranges');
  rs.innerHTML = '';
  for (const [hrs, label] of [[6, '6 h'], [24, '24 h'], [72, '3 days'], [168, '7 days']]) {
    rs.append(h('button', { class: range === hrs ? 'sel' : '', onclick: () => { range = hrs; loadHistory(); } }, label));
  }
  try {
    const lf = $('#log-filter');
    lf.innerHTML = '';
    for (const [k, label] of [['', 'All'], ['fault', 'Faults']]) {
      lf.append(h('button', { class: logKind === k ? 'sel' : '', style: 'padding:6px 12px', onclick: () => { logKind = k; loadHistory(); } }, label));
    }
    const [hist, log] = await Promise.all([api(`/api/history?hours=${range}`), api(`/api/log?limit=${logKind ? 300 : 80}${logKind ? `&kind=${logKind}` : ''}`)]);
    drawChart(hist);
    renderLog(log);
  } catch (e) {
    toast(e.message, true);
  }
}

function drawChart(hist) {
  const svg = $('#chart');
  const W = svg.clientWidth || 600;
  const H = 260;
  const pad = { l: 32, r: 8, t: 10, b: 24 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
    return e;
  };

  const lines = [];
  const acRows = hist.series.ac || [];
  lines.push({ name: 'Room (AC)', color: SERIES_COLORS[0], pts: acRows.map((r) => [r.ts, r.temp]) });
  lines.push({ name: 'Outside', color: SERIES_COLORS[1], pts: (hist.series.outside || []).map((r) => [r.ts, r.temp]) });
  let ci = 2;
  for (const s of S?.sensors || []) {
    const rows = hist.series[`sensor:${s.id}`] || [];
    lines.push({ name: s.name, color: SERIES_COLORS[ci++ % SERIES_COLORS.length], pts: rows.map((r) => [r.ts, r.temp]) });
  }
  const target = { name: 'Target (when on)', color: 'var(--muted)', dash: '4 4', pts: acRows.map((r) => [r.ts, r.power ? r.target : null]) };

  const all = [...lines, target].flatMap((l) => l.pts.filter((p) => p[1] != null));
  const legend = $('#legend');
  legend.innerHTML = '';
  if (!all.length) {
    el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }).textContent = 'No data yet — readings are recorded at each check.';
    return;
  }
  const t1 = Date.now();
  const t0 = hist.since;
  let lo = Math.floor(Math.min(...all.map((p) => p[1])) - 1);
  let hi = Math.ceil(Math.max(...all.map((p) => p[1])) + 1);
  if (hi - lo < 6) { const m = (hi + lo) / 2; lo = Math.floor(m - 3); hi = Math.ceil(m + 3); }
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

  // AC-on shading
  for (let i = 0; i < acRows.length; i++) {
    if (!acRows[i].power) continue;
    const a = acRows[i].ts;
    const b = acRows[i + 1]?.ts ?? Math.min(t1, a + 10 * 60_000);
    el('rect', { x: x(a), y: pad.t, width: Math.max(1, x(b) - x(a)), height: H - pad.t - pad.b, fill: 'var(--mode)', opacity: 0.08 });
  }
  // grid
  const step = hi - lo > 12 ? 4 : 2;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' });
    el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }).textContent = `${v}°`;
  }
  const ticks = range <= 24 ? 4 : range <= 72 ? 3 : 7;
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + ((t1 - t0) * i) / ticks;
    el('text', { x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }).textContent = range <= 24 ? fmtTime(t) : fmtDay(t);
  }
  // lines (break on gaps > 3 poll intervals or nulls)
  const gap = Math.max(3, 3 * (S?.settings?.pollMinutes || 5)) * 60_000;
  for (const l of [target, ...lines]) {
    let d = '';
    let prev = null;
    for (const [t, v] of l.pts) {
      if (v == null) { prev = null; continue; }
      d += `${prev == null || t - prev > gap ? 'M' : 'L'}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      prev = t;
    }
    if (d) el('path', { d, fill: 'none', stroke: l.color, 'stroke-width': l.dash ? 1.5 : 2, 'stroke-dasharray': l.dash || '', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    if (l.pts.some((p) => p[1] != null)) legend.append(h('span', {}, h('i', { style: `background:${l.color}` }), l.name));
  }
  // hover / touch readout
  const cursor = el('line', { y1: pad.t, y2: H - pad.b, stroke: 'var(--muted)', 'stroke-width': 1, opacity: 0 });
  const nearest = (pts, t) => {
    let best = null;
    for (const p of pts) if (p[1] != null && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p;
    return best && Math.abs(best[0] - t) < gap ? best : null;
  };
  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((px - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
    if (t < t0 || t > t1) return;
    cursor.setAttribute('x1', px);
    cursor.setAttribute('x2', px);
    cursor.setAttribute('opacity', 0.5);
    const parts = [...lines, target].map((l) => { const p = nearest(l.pts, t); return p ? `${l.name} ${p[1].toFixed(1)}°` : null; }).filter(Boolean);
    $('#tip').textContent = `${fmtWhen(t)} · ${parts.join(' · ') || 'no data'}`;
  };
  svg.onpointermove = onMove;
  svg.onpointerdown = onMove;
}

function renderLog(log) {
  const ul = $('#log');
  ul.innerHTML = '';
  if (!log.length) {
    ul.append(h('li', {}, h('span'), h('span', { class: 'muted' },
      logKind === 'fault' ? 'No faults recorded. Faults are logged from 2 November 2026 onwards.' : 'Nothing yet.')));
  }
  for (const l of log) {
    const text = l.kind === 'manual' ? `You: ${l.message}` : l.kind === 'notify' ? `🔔 ${l.message}`
      : l.kind === 'fault' ? `${/cleared/.test(l.message) ? '✅' : '⚠️'} ${l.message}` : l.message;
    ul.append(h('li', {}, h('time', {}, fmtWhen(l.ts)),
      h('span', { class: l.kind === 'error' || (l.kind === 'fault' && !/cleared/.test(l.message)) ? 'error' : '' }, text)));
  }
}

// ---------- settings ----------

async function loadSettings() {
  if (!S) await loadState();
  const s = S.settings;
  $('#set-name').value = s.name || '';
  $('#set-poll').value = String(s.pollMinutes || 5);
  $('#set-ntfy').value = s.ntfyTopic || '';
  $('#place-now').innerHTML = s.lat != null ? `Using <b>${escapeHtml(s.place || `${s.lat}, ${s.lon}`)}</b> · ${escapeHtml(s.tz)}` : 'No location set yet.';
  $('#place-results').innerHTML = '';
  $('#tick-info').textContent = S.lastTick ? `Last automatic check ${fmtWhen(S.lastTick.ts)} (${S.lastTick.calls} Tuya call${S.lastTick.calls === 1 ? '' : 's'}).` : 'No automatic check has run yet.';
  const sa = $('#sensor-admin');
  sa.innerHTML = '';
  for (const x of S.sensors) {
    sa.append(h('div', { class: 'row', style: 'padding:8px 0;border-bottom:1px solid var(--line)' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, x.name), h('div', { class: 'small muted', style: 'overflow:hidden;text-overflow:ellipsis' }, x.id)),
      h('button', {
        class: 'btn small danger',
        onclick: async () => {
          if (!confirm(`Remove ${x.name}? Rules that use it will stop seeing its readings.`)) return;
          await api(`/api/sensors/${x.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, true));
          await loadState();
          loadSettings();
        },
      }, 'Remove')));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

$('#save-settings').onclick = async () => {
  if ($('#place-q').value.trim()) {
    toast('To set the location, tap Search and then tap your area in the list', true);
    return;
  }
  try {
    S.settings = await api('/api/settings', { method: 'PUT', body: { name: $('#set-name').value, pollMinutes: Number($('#set-poll').value), ntfyTopic: $('#set-ntfy').value } });
    toast('Saved');
    renderControl();
  } catch (e) {
    toast(e.message, true);
  }
};

async function placeSearch() {
  const q = $('#place-q').value.trim();
  if (!q) return;
  const box = $('#place-results');
  box.innerHTML = '<div class="small muted">Searching…</div>';
  try {
    const results = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    box.innerHTML = '';
    box.append(h('div', { class: 'small muted' }, results.length ? 'Tap your area to use it:' : 'Nothing found — try a postcode district like SW11 or a town name.'));
    for (const r of results) {
      box.append(h('button', {
        onclick: async () => {
          try {
            S.settings = await api('/api/settings', { method: 'PUT', body: { place: r.name, lat: r.lat, lon: r.lon, tz: r.tz || 'Europe/London' } });
            toast(`Location set to ${r.name}`);
            $('#place-q').value = '';
            await loadState();
            loadSettings();
          } catch (e) {
            toast(e.message, true);
          }
        },
      }, `📍 ${r.name}`));
    }
  } catch (e) {
    box.innerHTML = '';
    toast(e.message, true);
  }
}
$('#place-search').onclick = placeSearch;
$('#place-q').onkeydown = (e) => { if (e.key === 'Enter') placeSearch(); };

$('#sensor-add').onclick = async () => {
  const btn = $('#sensor-add');
  btn.disabled = true;
  try {
    await api('/api/sensors', { method: 'POST', body: { id: $('#sensor-id').value.trim(), name: $('#sensor-name').value.trim() } });
    $('#sensor-id').value = '';
    $('#sensor-name').value = '';
    toast('Sensor added');
    await loadState();
    loadSettings();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
};

$('#ntfy-test').onclick = async () => {
  try {
    S.settings = await api('/api/settings', { method: 'PUT', body: { ntfyTopic: $('#set-ntfy').value } });
    const r = await api('/api/notify-test', { method: 'POST' });
    toast(r.ok ? 'Sent — check your phone' : 'ntfy did not accept it', !r.ok);
  } catch (e) {
    toast(e.message, true);
  }
};

$('#run-tick').onclick = async () => {
  const btn = $('#run-tick');
  btn.disabled = true;
  try {
    const r = await api('/api/tick', { method: 'POST' });
    toast(r.error ? r.error : r.change && Object.keys(r.change).length ? 'Rules ran and changed the AC' : 'Rules ran — nothing to change', !!r.error);
    await loadState();
    loadSettings();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
};

// ---------- login ----------

function showLogin() {
  if (!$('#login').hidden) return;
  $('#login').hidden = false;
  $('#login-err').textContent = '';
  setTimeout(() => $('#login-pw').focus(), 50);
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true;
  $('#login-err').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ password: $('#login-pw').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    $('#login-pw').value = '';
    $('#login').hidden = true;
    await loadState();
    showTab(tab);
  } catch (err) {
    $('#login-err').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

$('#sign-out').onclick = async () => {
  if (!confirm('Sign out on this device? You’ll need the password to get back in.')) return;
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  showLogin();
};

// ---------- tabs & refresh ----------

function showTab(name) {
  tab = name;
  for (const b of document.querySelectorAll('nav.tabs button')) b.classList.toggle('sel', b.dataset.tab === name);
  for (const t of ['control', 'rules', 'history', 'settings']) $(`#tab-${t}`).hidden = t !== name;
  try { localStorage.setItem('tab', name); } catch {}
  if (name === 'control') loadState();
  if (name === 'rules') loadRules();
  if (name === 'history') loadHistory();
  if (name === 'settings') loadSettings();
  window.scrollTo(0, 0);
}
for (const b of document.querySelectorAll('nav.tabs button')) b.onclick = () => showTab(b.dataset.tab);

setInterval(() => {
  if (document.visibilityState === 'visible' && tab === 'control' && pendingTemp == null) loadState();
}, 30_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tab === 'control') loadState();
});
window.addEventListener('resize', () => { if (tab === 'history') loadHistory(); });

let startTab = 'control';
try { startTab = localStorage.getItem('tab') || 'control'; } catch {}
loadState().then(() => showTab(startTab));

// iOS Safari ignores user-scalable=no for pinch; block its gesture events instead.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
