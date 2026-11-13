import { kvGet, kvSet } from './db.js';

// Verifies the Cloudflare Access JWT that Access adds to every request it lets through.
// Access itself blocks strangers at the edge; this check makes sure nothing can reach
// the API by any other route (workers.dev is also disabled in wrangler.jsonc).

let certCache = { keys: null, fetched: 0 };

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function accessKeys(team) {
  if (certCache.keys && Date.now() - certCache.fetched < 3_600_000) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  const j = await res.json();
  certCache = { keys: j.keys, fetched: Date.now() };
  return j.keys;
}

export async function verifyAccess(request, env) {
  if (env.ALLOW_NO_AUTH === '1') return { email: 'local-dev' };
  const team = env.ACCESS_TEAM_DOMAIN; // e.g. yourteam.cloudflareaccess.com
  const aud = env.ACCESS_AUD;
  if (!team || !aud) return null;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    if (payload.iss !== `https://${team}`) return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return { email: payload.email };
  } catch {
    return null;
  }
}

// ---------- Shared household password ----------
// The password lives in the APP_PASSWORD secret. A successful login gets a signed,
// HttpOnly cookie valid for SESSION_DAYS. The signing key is derived from the password,
// so changing the password signs every device out.


const COOKIE = 'ac_session';
const SESSION_DAYS = 180;
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60_000;
const enc = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(keyBytes, text) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

async function sessionKey(env) {
  let salt = await kvGet(env, 'session_salt');
  if (!salt) {
    salt = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await kvSet(env, 'session_salt', salt);
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${salt}:${env.APP_PASSWORD}`)));
}

// Compare via HMAC so timing doesn't reveal how much of the password matched.
async function sameSecret(a, b) {
  const k = crypto.getRandomValues(new Uint8Array(32));
  const [x, y] = await Promise.all([hmac(k, a), hmac(k, b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function readCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

export async function verifySession(request, env) {
  if (!env.APP_PASSWORD) return null;
  const raw = readCookie(request, COOKIE);
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(await hmac(await sessionKey(env), payload));
  if (!(await sameSecret(sig, expected))) return null;
  try {
    const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return data.exp > Date.now() ? { email: 'household' } : null;
  } catch {
    return null;
  }
}

export async function login(request, env) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };
  const reply = (status, data, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...headers, ...extra } });
  if (!env.APP_PASSWORD) return reply(503, { error: 'No password has been set up yet' });

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const failKey = `login_fail:${ip}`;
  const fails = (await kvGet(env, failKey)) || { count: 0, first: Date.now() };
  if (Date.now() - fails.first > LOCK_MS) Object.assign(fails, { count: 0, first: Date.now() });
  if (fails.count >= MAX_FAILS) {
    const mins = Math.ceil((fails.first + LOCK_MS - Date.now()) / 60_000);
    return reply(429, { error: `Too many wrong attempts — try again in ${mins} min` });
  }

  let password = '';
  try {
    password = String((await request.json()).password || '');
  } catch {}
  if (!(await sameSecret(password, env.APP_PASSWORD))) {
    fails.count++;
    await kvSet(env, failKey, fails);
    return reply(401, { error: 'Wrong password' });
  }
  await env.DB.prepare('DELETE FROM kv WHERE k = ?').bind(failKey).run();

  const payload = b64url(enc.encode(JSON.stringify({ iat: Date.now(), exp: Date.now() + SESSION_DAYS * 86_400_000 })));
  const sig = b64url(await hmac(await sessionKey(env), payload));
  const cookie = `${COOKIE}=${payload}.${sig}; Path=/; Max-Age=${SESSION_DAYS * 86_400}; HttpOnly; Secure; SameSite=Lax`;
  return reply(200, { ok: true }, { 'set-cookie': cookie });
}

export function logout() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
  });
}
