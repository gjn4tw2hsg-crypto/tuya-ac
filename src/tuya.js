// Minimal Tuya Cloud client (v2 "Things" API) for Cloudflare Workers.
// Signing follows Tuya's HMAC-SHA256 scheme:
//   stringToSign = METHOD \n sha256(body) \n (signed headers, none) \n path?sortedQuery
//   sign = HMAC(clientId [+ accessToken] + t + nonce + stringToSign, secret)

import { kvGet, kvSet } from './db.js';

const enc = new TextEncoder();

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function signedPath(path, query) {
  const keys = Object.keys(query || {}).sort();
  if (!keys.length) return path;
  return path + '?' + keys.map((k) => `${k}=${query[k]}`).join('&');
}

export class TuyaError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export class Tuya {
  constructor(env) {
    this.env = env;
    this.base = env.TUYA_BASE || 'https://openapi.tuyaeu.com';
    this.clientId = env.TUYA_CLIENT_ID;
    this.secret = env.TUYA_CLIENT_SECRET;
    this.calls = 0;
  }

  async raw(method, path, { query, body, token } = {}) {
    if (!this.clientId || !this.secret) throw new TuyaError('TUYA_CLIENT_ID / TUYA_CLIENT_SECRET not configured');
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const url = signedPath(path, query);
    const t = String(Date.now());
    const nonce = crypto.randomUUID();
    const stringToSign = [method, await sha256Hex(bodyText), '', url].join('\n');
    const sign = await hmacHex(this.secret, this.clientId + (token || '') + t + nonce + stringToSign);
    const headers = {
      client_id: this.clientId,
      sign,
      t,
      nonce,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    };
    if (token) headers.access_token = token;
    this.calls++;
    const res = await fetch(this.base + url, { method, headers, body: bodyText || undefined });
    const json = await res.json().catch(() => ({ success: false, msg: `HTTP ${res.status}` }));
    if (!json.success) throw new TuyaError(`Tuya ${path}: ${json.msg || 'error'} (${json.code ?? res.status})`, json.code);
    return json.result;
  }

  async token(force = false) {
    if (!force) {
      const cached = await kvGet(this.env, 'tuya_token');
      if (cached && cached.expires > Date.now() + 60_000) return cached.access_token;
    }
    const r = await this.raw('GET', '/v1.0/token', { query: { grant_type: 1 } });
    await kvSet(this.env, 'tuya_token', { access_token: r.access_token, expires: Date.now() + r.expire_time * 1000 });
    return r.access_token;
  }

  async call(method, path, opts = {}) {
    try {
      return await this.raw(method, path, { ...opts, token: await this.token() });
    } catch (e) {
      // 1010 = token invalid, 1011 = token expired
      if (e.code === 1010 || e.code === 1011) return this.raw(method, path, { ...opts, token: await this.token(true) });
      throw e;
    }
  }

  // { code: value } map of the device's current properties
  async properties(deviceId) {
    const r = await this.call('GET', `/v2.0/cloud/thing/${deviceId}/shadow/properties`);
    const out = {};
    for (const p of r.properties || []) out[p.code] = p.value;
    return out;
  }

  async issue(deviceId, props) {
    return this.call('POST', `/v2.0/cloud/thing/${deviceId}/shadow/properties/issue`, {
      body: { properties: JSON.stringify(props) },
    });
  }

  async info(deviceId) {
    return this.call('GET', `/v2.0/cloud/thing/${deviceId}`);
  }

  async model(deviceId) {
    const r = await this.call('GET', `/v2.0/cloud/thing/${deviceId}/model`);
    return typeof r.model === 'string' ? JSON.parse(r.model) : r.model;
  }
}

// In-memory fake device for local development (TUYA_MOCK=1). State lives in D1 kv
// so it survives between requests and the cron tick can "see" commands.
export class MockTuya {
  constructor(env) {
    this.env = env;
    this.calls = 0;
  }

  async state() {
    return (
      (await kvGet(this.env, 'mock_ac')) || {
        Power: false, temp_set: 22, temp_current: 25, mode: 'cold', windspeed: '1', mode_ECO: false, heat: false,
        mode_sleep: false, screen: true, clean: false, health: false, wind_vertical: false, wind_horizontal: false,
        temp_unit_convert: 'c', model_report: 0b0011, fault_1: 0, fault_2: 0,
      }
    );
  }

  async properties(deviceId) {
    this.calls++;
    if (deviceId.startsWith('mocksensor')) {
      const drift = Math.sin(Date.now() / 3_600_000) * 1.5;
      return { va_temperature: Math.round((23 + drift) * 10), va_humidity: 48 };
    }
    const s = await this.state();
    // Drift the room temperature towards the setpoint while running, towards 26 while off.
    const goal = s.Power && s.mode === 'cold' ? s.temp_set : s.Power && s.mode === 'hot' ? s.temp_set : 26;
    s.temp_current = Math.round(s.temp_current + Math.sign(goal - s.temp_current) * 0.5);
    await kvSet(this.env, 'mock_ac', s);
    return s;
  }

  async issue(deviceId, props) {
    this.calls++;
    const s = await this.state();
    await kvSet(this.env, 'mock_ac', { ...s, ...props });
    return true;
  }

  async info(deviceId) {
    this.calls++;
    return { id: deviceId, name: 'Mock AC', is_online: true };
  }

  async model(deviceId) {
    this.calls++;
    return {
      services: [
        {
          properties: [
            { code: 'va_temperature', name: 'Temperature', typeSpec: { type: 'value', scale: 1, unit: '℃' } },
            { code: 'va_humidity', name: 'Humidity', typeSpec: { type: 'value', scale: 0, unit: '%' } },
          ],
        },
      ],
    };
  }
}

export function tuyaClient(env) {
  return env.TUYA_MOCK === '1' ? new MockTuya(env) : new Tuya(env);
}
