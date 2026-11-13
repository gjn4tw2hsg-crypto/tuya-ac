// What the Electriq Easy-fit air conditioner (Tuya model 00000035n3) accepts.
export const WRITABLE = {
  Power: { type: 'bool' },
  temp_set: { type: 'int', min: 16, max: 32 },
  mode: { type: 'enum', values: ['cold', 'hot', 'wet', 'wind', 'auto'] },
  // 1 = auto, 2 = turbo, 3 = low, 4 = medium, 5 = high
  windspeed: { type: 'enum', values: ['1', '2', '3', '4', '5'] },
  mode_ECO: { type: 'bool' },
  heat: { type: 'bool' },
  mode_sleep: { type: 'bool' },
  health: { type: 'bool' },
  clean: { type: 'bool' },
  screen: { type: 'bool' },
  wind_vertical: { type: 'bool' },
  wind_horizontal: { type: 'bool' },
};

// Validate and normalise a { code: value } command. Throws on anything unknown.
export function validateProps(props) {
  const out = {};
  for (const [code, value] of Object.entries(props || {})) {
    const spec = WRITABLE[code];
    if (!spec) throw new Error(`Unknown property: ${code}`);
    if (spec.type === 'bool') {
      if (typeof value !== 'boolean') throw new Error(`${code} must be true/false`);
      out[code] = value;
    } else if (spec.type === 'int') {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) throw new Error(`${code} must be ${spec.min}–${spec.max}`);
      out[code] = n;
    } else if (spec.type === 'enum') {
      if (!spec.values.includes(String(value))) throw new Error(`${code} must be one of ${spec.values.join(', ')}`);
      out[code] = String(value);
    }
  }
  return out;
}

// model_report bitmap: bit1 = heat pump (cool + heat), bit3 = electric aux heater.
// Unknown (null/undefined) is treated as capable so nothing gets hidden by mistake.
export function capabilities(props) {
  const m = props?.model_report;
  if (typeof m !== 'number') return { heatPump: true, auxHeater: true, known: false };
  return { heatPump: !!(m & 0b10), auxHeater: !!(m & 0b1000), known: true, inverter: !!(m & 0b1) };
}

// Fault bitmaps → list of fault numbers (1–29) as used in the unit's fault table.
export function faults(props) {
  const list = [];
  const f1 = Number(props?.fault_1) || 0;
  const f2 = Number(props?.fault_2) || 0;
  for (let b = 0; b < 15; b++) if (f1 & (1 << b)) list.push(b + 1);
  for (let b = 0; b < 14; b++) if (f2 & (1 << b)) list.push(b + 16);
  return list;
}

// Rule action (friendly names) → Tuya properties.
export function actionProps(a = {}) {
  if (a.power === 'off') return { Power: false };
  const p = {};
  if (a.power === 'on') p.Power = true;
  if (a.mode) p.mode = a.mode;
  if (a.temp != null && a.temp !== '') p.temp_set = Math.min(32, Math.max(16, Math.round(Number(a.temp))));
  if (a.fan) p.windspeed = String(a.fan);
  const bools = { swingV: 'wind_vertical', swingH: 'wind_horizontal', eco: 'mode_ECO', sleep: 'mode_sleep', screen: 'screen', heat: 'heat' };
  for (const [k, code] of Object.entries(bools)) if (typeof a[k] === 'boolean') p[code] = a[k];
  return p;
}

// Only the properties that would actually change the device.
export function diffProps(current, desired) {
  if (desired.Power === false) return current.Power === false ? {} : { Power: false };
  const out = {};
  for (const [k, v] of Object.entries(desired)) if (current[k] !== v) out[k] = v;
  return out;
}

// Which fault codes appeared or cleared since the last check.
export function diffFaults(prev = [], curr = []) {
  return { added: curr.filter((f) => !prev.includes(f)), cleared: prev.filter((f) => !curr.includes(f)) };
}
