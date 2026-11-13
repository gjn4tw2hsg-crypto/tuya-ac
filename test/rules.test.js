import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, inWindow, localTime, mergeCommands, evalConditions } from '../src/rules.js';
import { diffProps, actionProps, faults, capabilities } from '../src/ac.js';

const at = (dow, hm) => {
  const [h, m] = hm.split(':').map(Number);
  return { dow, minutes: h * 60 + m, date: `2026-09-${20 + dow}`, hm };
};
const rule = (id, def, state = {}) => ({ id, name: `r${id}`, enabled: true, def, state });

test('localTime handles London time zone', () => {
  const l = localTime(Date.UTC(2026, 6, 1, 12, 30), 'Europe/London'); // BST
  assert.equal(l.hm, '13:30');
  assert.equal(l.dow, 3);
});

test('overnight window belongs to the start day', () => {
  const w = { from: '22:00', to: '07:00' };
  assert.equal(inWindow(at(5, '23:00'), [5], w), true); // Fri night
  assert.equal(inWindow(at(6, '06:00'), [5], w), true); // Sat early = Fri's window
  assert.equal(inWindow(at(6, '23:00'), [5], w), false);
  assert.equal(inWindow(at(5, '12:00'), [], w), false);
});

test('schedule fires once, with conditions on forecast', () => {
  const r = rule(1, { kind: 'schedule', at: '14:00', days: [], conditions: [{ src: 'forecast_max', op: '>', value: 27 }], action: { power: 'on', mode: 'cold', temp: 23 } });
  const hot = { now: 1, local: at(3, '14:02'), ac: { Power: false }, weather: { todayMax: 29 } };
  const res = evaluateRules([r], hot);
  assert.deepEqual(res.commands[0].props, { Power: true, mode: 'cold', temp_set: 23 });
  r.state = res.states.get(1);
  assert.equal(evaluateRules([r], hot).commands.length, 0);
  const cool = evaluateRules([rule(1, r.def)], { ...hot, weather: { todayMax: 20 } });
  assert.equal(cool.commands.length, 0);
  assert.equal(cool.logs.length, 1);
});

test('condition rule is edge-triggered and compares sources', () => {
  const def = { kind: 'condition', conditions: [{ src: 'outside', op: '<', cmp: 'room', offset: -2 }, { src: 'ac_on', op: '=', value: 1 }], action: {}, notify: 'Open a window', cooldownMin: 0 };
  let r = rule(2, def);
  const ctx = { now: 1000, local: at(1, '12:00'), ac: { Power: true, temp_current: 26 }, weather: { temp: 18 } };
  let res = evaluateRules([r], ctx);
  assert.equal(res.notifications.length, 1);
  r.state = res.states.get(2);
  res = evaluateRules([r], ctx);
  assert.equal(res.notifications.length, 0);
  // weather missing → unknown → state unchanged
  res = evaluateRules([r], { ...ctx, weather: null });
  assert.equal(res.states.get(2).lastCond, true);
});

test('thermostat cools on remote sensor, stops at target, respects min cycle', () => {
  const def = { kind: 'thermostat', conditions: [], window: null, thermostat: { target: 22, band: 0.5, sensor: 'sensor:abc', mode: 'cold', offset: 1, minCycleMin: 6 } };
  let r = rule(3, def);
  const ctx = (now, t, on) => ({ now, local: at(2, '15:00'), ac: { Power: on, mode: 'cold' }, sensors: { abc: { temp: t } } });
  let res = evaluateRules([r], ctx(0 + 10e6, 23, false));
  assert.deepEqual(res.commands[0].props, { Power: true, mode: 'cold', temp_set: 21 });
  r.state = res.states.get(3);
  res = evaluateRules([r], ctx(10e6 + 60_000, 21, true)); // too soon
  assert.equal(res.commands.length, 0);
  r.state = res.states.get(3);
  res = evaluateRules([r], ctx(10e6 + 7 * 60_000, 21.4, true));
  assert.deepEqual(res.commands[0].props, { Power: false });
});

test('thermostat stands down after manual off', () => {
  const def = { kind: 'thermostat', conditions: [], thermostat: { target: 22, band: 0.5, sensor: 'room', mode: 'cold', minCycleMin: 0 } };
  const r = rule(4, def, { active: true, running: true, runMode: 'cold', lastSwitch: 0 });
  const res = evaluateRules([r], { now: 1e7, local: at(2, '15:00'), ac: { Power: false, temp_current: 27 } });
  assert.equal(res.commands.length, 0);
  assert.equal(res.states.get(4).standDown, true);
});

test('thermostat turns off at window end only if it was running', () => {
  const def = { kind: 'thermostat', window: { from: '09:00', to: '17:00' }, conditions: [], thermostat: { target: 22, sensor: 'room' } };
  const r = rule(5, def, { active: true, running: true, runMode: 'cold' });
  const res = evaluateRules([r], { now: 1e7, local: at(2, '17:01'), ac: { Power: true, temp_current: 22 } });
  assert.deepEqual(res.commands[0].props, { Power: false });
});

test('merge and diff', () => {
  assert.deepEqual(mergeCommands([{ props: { Power: true, temp_set: 22 } }, { props: { Power: false } }]), { Power: false });
  assert.deepEqual(diffProps({ Power: true, temp_set: 22, mode: 'cold' }, { Power: true, temp_set: 21, mode: 'cold' }), { temp_set: 21 });
  assert.deepEqual(diffProps({ Power: false }, { Power: false }), {});
  assert.deepEqual(actionProps({ power: 'on', fan: '3', swingV: true }), { Power: true, windspeed: '3', wind_vertical: true });
  assert.deepEqual(faults({ fault_1: 0b101, fault_2: 1 }), [1, 3, 16]);
  assert.equal(capabilities({ model_report: 0b0001 }).heatPump, false);
  assert.equal(evalConditions([], {}), true);
});

import { smartAutoStep } from '../src/rules.js';

test('smart auto starts, flips modes with hysteresis, stops on manual change', () => {
  const cfg = { enabled: true, target: 22, sensor: 'room', band: 1.5, minSwitchMin: 15 };
  const ctx = (now, t, ac) => ({ now, ac: { temp_current: t, ...ac }, caps: { heatPump: true } });
  let r = smartAutoStep(cfg, {}, ctx(0, 19, { Power: false, mode: 'auto' }));
  assert.deepEqual(r.props, { Power: true, mode: 'hot', temp_set: 22 });
  let st = r.state;
  r = smartAutoStep(cfg, st, ctx(60e6, 23, { Power: true, mode: 'hot', temp_set: 22 })); // within band
  assert.deepEqual(r.props, {});
  r = smartAutoStep(cfg, st, ctx(60e6, 23.5, { Power: true, mode: 'hot', temp_set: 22 }));
  assert.deepEqual(r.props, { mode: 'cold', temp_set: 22 });
  st = r.state;
  r = smartAutoStep(cfg, st, ctx(60e6 + 60_000, 20, { Power: true, mode: 'cold', temp_set: 22 })); // too soon to flip
  assert.deepEqual(r.props, {});
  assert.equal(smartAutoStep(cfg, st, ctx(70e6, 22, { Power: false, mode: 'cold' })).disable, true);
  assert.equal(smartAutoStep(cfg, st, ctx(70e6, 22, { Power: true, mode: 'wet' })).disable, true);
  // no heat pump → always cool
  r = smartAutoStep(cfg, {}, { now: 0, ac: { temp_current: 15, Power: false }, caps: { heatPump: false } });
  assert.equal(r.props.mode, 'cold');
});

import { diffFaults } from '../src/ac.js';
test('fault diff', () => {
  assert.deepEqual(diffFaults([], [3]), { added: [3], cleared: [] });
  assert.deepEqual(diffFaults([3, 16], [16]), { added: [], cleared: [3] });
  assert.deepEqual(diffFaults([1], [1]), { added: [], cleared: [] });
});

test('thermostat resumes when the AC is switched back on after a manual off', () => {
  const def = { kind: 'thermostat', conditions: [], thermostat: { target: 27, band: 1, sensor: 'room', mode: 'hot', offset: 1, minCycleMin: 6 } };
  // This morning's case: paused by a manual off, then switched back on, room overshoots to 29°.
  const r = rule(6, def, { active: true, running: false, standDown: true, runMode: 'hot', lastSwitch: 0 });
  const res = evaluateRules([r], { now: 1e7, local: at(1, '09:55'), ac: { Power: true, mode: 'hot', temp_current: 29 } });
  assert.deepEqual(res.commands[0].props, { Power: false });
  assert.equal(res.states.get(6).standDown, false);
  // Switched back on in Fan mode: stays paused (only Heat/Cool resume it).
  const r2 = rule(7, def, { active: true, running: false, standDown: true });
  const res2 = evaluateRules([r2], { now: 1e7, local: at(1, '09:55'), ac: { Power: true, mode: 'wind', temp_current: 29 } });
  assert.equal(res2.commands.length, 0);
  assert.equal(res2.states.get(7).standDown, true);
});

test('thermostat takes over an AC already on at window start, but respects a mid-window manual setpoint', () => {
  const def = { kind: 'thermostat', days: [1, 2, 3, 4, 5], window: { from: '08:00', to: '15:00' }, conditions: [],
    thermostat: { target: 27, band: 1, sensor: 'room', mode: 'hot', fan: '3', offset: 1, minCycleMin: 6 } };
  // This morning: overnight frost rule left it heating at 16°, room 19° when the window opens.
  const r = rule(8, def, { active: false, running: false, standDown: false });
  const res = evaluateRules([r], { now: 1e8, local: at(2, '08:00'), ac: { Power: true, mode: 'hot', temp_set: 16, windspeed: '1', temp_current: 19 } });
  assert.deepEqual(res.commands[0].props, { temp_set: 28, windspeed: '3' });
  assert.equal(res.states.get(8).running, true);
  // Mid-window: user switches it on at 25° → adopted, setpoint left alone.
  const r2 = rule(9, def, { active: true, running: false, standDown: false });
  const res2 = evaluateRules([r2], { now: 1e8, local: at(2, '11:00'), ac: { Power: true, mode: 'hot', temp_set: 25, temp_current: 24 } });
  assert.equal(res2.commands.length, 0);
  assert.equal(res2.states.get(9).running, true);
  // Already warm at window start → it takes over and then switches off at the upper band.
  const r3 = rule(10, def, { active: false });
  const res3 = evaluateRules([r3], { now: 1e8, local: at(2, '08:00'), ac: { Power: true, mode: 'hot', temp_set: 16, temp_current: 29 } });
  assert.deepEqual(mergeCommands(res3.commands), { Power: false });
});

// ---------- tonight's low and ready-by ----------
import { tonightLow, warmupMinutes, WARMUP_DEFAULT_RATES } from '../src/rules.js';

const hourly = (startDate, temps) => temps.map((temp, i) => {
  const d = new Date(`${startDate}T00:00:00Z`);
  d.setUTCHours(i);
  return { t: d.toISOString().slice(0, 13) + ':00', temp };
});
const day = (date, hm, dow = 5) => {
  const [h, m] = hm.split(':').map(Number);
  return { dow, minutes: h * 60 + m, date, hm };
};

test("tonight's low looks from now to the next 08:00", () => {
  // Fri 13th: 0–23h, then Sat 14th 0–23h. Coldest tonight is Sat 05:00 (−2); Sat 10:00 (−5) is after 08:00.
  const temps = Array.from({ length: 48 }, (_, i) => (i === 29 ? -2 : i === 34 ? -5 : i === 3 ? -9 : 6));
  const weather = { hourly: hourly('2026-11-13', temps) };
  assert.equal(tonightLow({ weather, local: day('2026-11-13', '15:05') }), -2);
  // Before 08:00 it means the rest of this night: Fri 03:00 (−9) is already past at 04:10.
  assert.equal(tonightLow({ weather, local: day('2026-11-13', '04:10') }), 6);
  assert.equal(tonightLow({ weather: null, local: day('2026-11-13', '15:05') }), null);
  const r = rule(9, { kind: 'schedule', at: '15:05', days: [], conditions: [{ src: 'tonight_min', op: '>=', value: 5 }], action: { power: 'off' } });
  const res = evaluateRules([r], { now: 1, local: day('2026-11-13', '15:05'), ac: { Power: true }, weather });
  assert.equal(res.commands.length, 0); // −2 tonight: stays on
});

test('ready-by starts earlier when it is colder, then learns', () => {
  const def = { kind: 'warmup', days: [], conditions: [], warmup: { at: '08:00', earliest: '05:00', target: 25, mode: 'hot', fan: null, marginMin: 15 } };
  const ctx = (hm, room, outside, now = 1e9) => ({ now, local: day('2026-11-16', hm, 1), ac: { Power: true, mode: 'hot', temp_current: room }, weather: { temp: outside } });

  // Mild (10° out), room 16°: 9° at 0.22°/min ≈ 41 min + 15 → starts about 07:04.
  const need = warmupMinutes(16, 10, 25) + 15;
  assert.equal(need, 41 + 15);
  assert.equal(evaluateRules([rule(5, def)], ctx('07:00', 16, 10)).commands.length, 0);
  const mild = evaluateRules([rule(5, def)], ctx('07:05', 16, 10));
  assert.deepEqual(mild.commands[0].props, { Power: true, mode: 'hot', temp_set: 25 });

  // Frost (−1° out), room 16°: 9° at 0.05°/min = 180 min → as early as allowed (05:00).
  const frost = evaluateRules([rule(5, def)], ctx('05:00', 16, -1));
  assert.equal(frost.commands.length, 1);

  // Fires once a day only.
  const r = rule(5, def, frost.states.get(5));
  assert.equal(evaluateRules([r], ctx('05:05', 16.5, -1)).commands.length, 0);

  // Reached 24.5° 120 min later: learns 8.5°/120 min for "below 0°", blended 60/40 with nothing → that rate.
  const done = evaluateRules([r], ctx('07:00', 24.5, 2, 1e9 + 120 * 60_000));
  const rates = done.states.get(5).rates;
  assert.ok(Math.abs(rates.lt0 - 8.5 / 120) < 0.001, JSON.stringify(rates));
  assert.equal(done.logs.length, 1);

  // Already warm at 08:00 (e.g. a mild day): still switches on at the deadline to hold it.
  const warm = evaluateRules([rule(5, def)], ctx('08:00', 25, 12));
  assert.equal(warm.commands.length, 1);
  assert.equal(evaluateRules([rule(5, def)], ctx('07:30', 25, 12)).commands.length, 0);

  // Not on its days / after 09:00: nothing.
  assert.equal(evaluateRules([rule(5, { ...def, days: [6, 7] })], ctx('07:59', 10, 0)).commands.length, 0);
  assert.equal(evaluateRules([rule(5, def)], ctx('09:30', 10, 0)).commands.length, 0);
  assert.ok(WARMUP_DEFAULT_RATES['9-12'] > WARMUP_DEFAULT_RATES.lt0);
});
