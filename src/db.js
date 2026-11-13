export async function kvGet(env, k) {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return row ? JSON.parse(row.v) : null;
}

export async function kvSet(env, k, v) {
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind(k, JSON.stringify(v))
    .run();
}

export const DEFAULT_SETTINGS = {
  name: 'Air conditioner',
  place: '',
  lat: null,
  lon: null,
  tz: 'Europe/London',
  pollMinutes: 5,
  ntfyTopic: '',
  pauseUntil: 0,
};

export async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...((await kvGet(env, 'settings')) || {}) };
}

export async function saveSettings(env, patch) {
  const next = { ...(await getSettings(env)), ...patch };
  await kvSet(env, 'settings', next);
  return next;
}

export async function addLog(env, kind, message) {
  await env.DB.prepare('INSERT INTO log (ts, kind, message) VALUES (?, ?, ?)').bind(Date.now(), kind, message).run();
}

export async function listSensors(env) {
  const { results } = await env.DB.prepare('SELECT * FROM sensors ORDER BY created').all();
  return results;
}

export async function listRules(env) {
  const { results } = await env.DB.prepare('SELECT * FROM rules ORDER BY sort, id').all();
  return results.map((r) => ({ ...r, enabled: !!r.enabled, def: JSON.parse(r.def), state: JSON.parse(r.state) }));
}
