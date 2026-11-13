// Outside weather from Open-Meteo (free, no key). Cached in kv for 15 minutes.
import { kvGet, kvSet } from './db.js';

const MAX_AGE = 15 * 60_000;

export async function getWeather(env, settings, { force = false } = {}) {
  if (settings.lat == null || settings.lon == null) return null;
  const cached = await kvGet(env, 'weather');
  const sameSpot = cached && cached.lat === settings.lat && cached.lon === settings.lon;
  if (!force && sameSpot && Date.now() - cached.fetched < MAX_AGE) return cached;

  const q = new URLSearchParams({
    latitude: settings.lat,
    longitude: settings.lon,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day',
    hourly: 'temperature_2m',
    daily: 'temperature_2m_max,temperature_2m_min',
    timezone: settings.tz || 'auto',
    forecast_days: '2',
  });
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const j = await res.json();
    const w = {
      lat: settings.lat,
      lon: settings.lon,
      fetched: Date.now(),
      temp: j.current.temperature_2m,
      feels: j.current.apparent_temperature,
      humidity: j.current.relative_humidity_2m,
      code: j.current.weather_code,
      isDay: !!j.current.is_day,
      todayMax: j.daily.temperature_2m_max[0],
      todayMin: j.daily.temperature_2m_min[0],
      tomorrowMax: j.daily.temperature_2m_max[1],
      tomorrowMin: j.daily.temperature_2m_min[1],
      // Next 24 hourly points, local time strings as returned (tz = settings.tz)
      hourly: j.hourly.time.map((t, i) => ({ t, temp: j.hourly.temperature_2m[i] })),
    };
    await kvSet(env, 'weather', w);
    return w;
  } catch (e) {
    // Serve stale data rather than nothing if the API hiccups
    return sameSpot ? cached : null;
  }
}

// Place search: UK postcodes via postcodes.io, anything else via Open-Meteo geocoding.
export async function geocode(q) {
  q = q.trim();
  const out = [];
  const pc = q.replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]{1,2}\d[A-Z\d]?(\d[A-Z]{2})?$/.test(pc)) {
    const full = pc.length > 4 && /\d[A-Z]{2}$/.test(pc);
    const url = full ? `https://api.postcodes.io/postcodes/${pc}` : `https://api.postcodes.io/outcodes/${pc}`;
    const r = await fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (r?.result) {
      const x = r.result;
      const area = full ? x.admin_district : (x.admin_district || [])[0];
      out.push({ name: `${full ? x.postcode : x.outcode}${area ? ', ' + area : ''}`, lat: x.latitude, lon: x.longitude, tz: 'Europe/London' });
    }
  }
  const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: '6', language: 'en' })}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  for (const x of g?.results || []) {
    out.push({ name: [x.name, x.admin1, x.country_code].filter(Boolean).join(', '), lat: x.latitude, lon: x.longitude, tz: x.timezone });
  }
  return out;
}
