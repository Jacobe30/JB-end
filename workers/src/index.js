/* Cloudflare Worker API for cards + D1
- Stores cards.id (UUID), name, phone_numbers (encrypted JSON), created_at
- Uses D1 binding: CARDS_DB
- Requires secret ENCRYPTION_KEY (base64, 32 bytes) set as Worker secret
*/

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 200; // example per-instance limit
const rateLimits = new Map(); // per-instance demo; not production

async function importKey(base64Key) {
  const raw = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

function base64FromBytes(bytes) {
  let s = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(s);
}

function bytesFromBase64(b64) {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}

async function encryptText(plain, base64Key) {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plain);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const cipherBytes = new Uint8Array(cipher);
  const combined = new Uint8Array(iv.length + cipherBytes.length);
  combined.set(iv, 0);
  combined.set(cipherBytes, iv.length);
  return base64FromBytes(combined);
}

async function decryptText(b64, base64Key) {
  const key = await importKey(base64Key);
  const combined = bytesFromBase64(b64);
  const iv = combined.subarray(0, 12);
  const cipher = combined.subarray(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plainBuf);
}

let CURRENT_REQUEST = null;
let CURRENT_ENV = null;

function makeCorsHeaders(request, env) {
  const origin = request && request.headers ? request.headers.get('Origin') : null;
  const allowedRaw = env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS : null;
  const allowed = allowedRaw ? allowedRaw.split(',').map(s => s.trim()).filter(Boolean) : null;
  let allowOrigin = '*';
  let allowCredentials = false;
  if (allowed && origin && allowed.includes(origin)) {
    allowOrigin = origin;
    allowCredentials = true;
  }
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-API-KEY,Authorization'
  };
  if (allowCredentials) headers['Access-Control-Allow-Credentials'] = 'true';
  return headers;
}

function jsonResponse(status, body, request = null, env = null) {
  const req = request || CURRENT_REQUEST;
  const e = env || CURRENT_ENV;
  const headers = makeCorsHeaders(req, e);
  return new Response(JSON.stringify(body), { status, headers });
}

function rateLimitOk(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip) || { ts: now, count: 0 };
  if (now - entry.ts > RATE_LIMIT_WINDOW_MS) {
    entry.ts = now; entry.count = 1;
    rateLimits.set(ip, entry);
    return { ok: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  entry.count += 1;
  rateLimits.set(ip, entry);
  return { ok: entry.count <= RATE_LIMIT_MAX, remaining: Math.max(0, RATE_LIMIT_MAX - entry.count) };
}

export default {
  async fetch(request, env) {
    CURRENT_REQUEST = request;
    CURRENT_ENV = env;
    try {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: makeCorsHeaders(request, env) });
      }

      // Require API key
      const apiKey = request.headers.get('X-API-KEY') || request.headers.get('x-api-key');
      if (!env.WORKER_API_KEY || !apiKey || apiKey !== env.WORKER_API_KEY) {
        return jsonResponse(401, { error: 'unauthorized' });
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "");
      const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'anon';
      const rl = rateLimitOk(ip);
      if (!rl.ok) return jsonResponse(429, { error: 'rate_limited' });

      // Basic routing
      if (path === '/cards' && request.method === 'POST') return handleCreate(request, env, rl);
      if (path === '/cards' && request.method === 'GET') return handleListOrSearch(request, env, rl);

      const cardIdMatch = path.match(/^\/cards\/([^/]+)$/);
      if (cardIdMatch) {
        const id = cardIdMatch[1];
        if (request.method === 'GET') return handleGet(request, env, id, rl);
        if (request.method === 'PUT' || request.method === 'PATCH') return handleUpdate(request, env, id, rl);
        if (request.method === 'DELETE') return handleDelete(request, env, id, rl);
      }

      return jsonResponse(404, { error: 'not_found' });
    } catch (err) {
      // Avoid leaking sensitive data
      console.error('handler_error', err && err.message ? err.message : String(err));
      return jsonResponse(500, { error: 'internal_error' });
    } finally {
      CURRENT_REQUEST = null;
      CURRENT_ENV = null;
    }
  }
};

async function handleCreate(request, env, rl) {
  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  const body = await safeParseJson(request);
  if (!body) return jsonResponse(400, { error: 'invalid_json' });
  const { name, phone_numbers } = body;
  if (!name || typeof name !== 'string') return jsonResponse(400, { error: 'invalid_name' });
  if (!Array.isArray(phone_numbers) || phone_numbers.some(p => typeof p !== 'string')) return jsonResponse(400, { error: 'invalid_phone_numbers' });

  // minimal validation for international format
  if (phone_numbers.some(p => !/^\+\d{6,15}$/.test(p))) return jsonResponse(400, { error: 'invalid_phone_format' });

  const id = crypto.randomUUID();
  const encKey = env.ENCRYPTION_KEY;
  if (!encKey) return jsonResponse(500, { error: 'encryption_not_configured' });

  const plain = JSON.stringify(phone_numbers);
  const encrypted = await encryptText(plain, encKey);

  // store as JSON: {"enc": "..."}
  await env.CARDS_DB.prepare('INSERT INTO cards (id, name, phone_numbers) VALUES (?, ?, ?)')
    .bind(id, name, JSON.stringify({ enc: encrypted }))
    .run();

  return jsonResponse(201, { card_id: id, name });
}

async function handleGet(request, env, id, rl) {
  const row = await env.CARDS_DB.prepare('SELECT id, name, phone_numbers, created_at FROM cards WHERE id = ?').bind(id).first();
  if (!row) return jsonResponse(404, { error: 'not_found' });
  const encKey = env.ENCRYPTION_KEY;
  if (!encKey) return jsonResponse(500, { error: 'encryption_not_configured' });
  let phones = [];
  try {
    const j = typeof row.phone_numbers === 'string' ? JSON.parse(row.phone_numbers) : row.phone_numbers;
    phones = JSON.parse(await decryptText(j.enc, encKey));
  } catch (e) {
    console.error('decrypt_error', e.message || e);
    return jsonResponse(500, { error: 'decryption_failed' });
  }
  return jsonResponse(200, { card_id: row.id, name: row.name, phone_numbers: phones, created_at: row.created_at });
}

async function handleUpdate(request, env, id, rl) {
  const body = await safeParseJson(request);
  if (!body) return jsonResponse(400, { error: 'invalid_json' });
  const { name, phone_numbers } = body;
  if (name !== undefined && typeof name !== 'string') return jsonResponse(400, { error: 'invalid_name' });
  if (phone_numbers !== undefined && (!Array.isArray(phone_numbers) || phone_numbers.some(p => typeof p !== 'string'))) return jsonResponse(400, { error: 'invalid_phone_numbers' });
  if (phone_numbers && phone_numbers.some(p => !/^\+\d{6,15}$/.test(p))) return jsonResponse(400, { error: 'invalid_phone_format' });

  const row = await env.CARDS_DB.prepare('SELECT id FROM cards WHERE id = ?').bind(id).first();
  if (!row) return jsonResponse(404, { error: 'not_found' });

  if (phone_numbers !== undefined) {
    const encKey = env.ENCRYPTION_KEY;
    if (!encKey) return jsonResponse(500, { error: 'encryption_not_configured' });
    const encrypted = await encryptText(JSON.stringify(phone_numbers), encKey);
    await env.CARDS_DB.prepare('UPDATE cards SET phone_numbers = ? WHERE id = ?').bind(JSON.stringify({ enc: encrypted }), id).run();
  }
  if (name !== undefined) {
    await env.CARDS_DB.prepare('UPDATE cards SET name = ? WHERE id = ?').bind(name, id).run();
  }
  return jsonResponse(200, { card_id: id });
}

async function handleDelete(request, env, id, rl) {
  const res = await env.CARDS_DB.prepare('DELETE FROM cards WHERE id = ?').bind(id).run();
  // D1 run() returns changes? Not guaranteed; do a select to verify
  return jsonResponse(200, { card_id: id });
}

async function handleListOrSearch(request, env, rl) {
  const url = new URL(request.url);
  const q = url.searchParams.get('search');
  const encKey = env.ENCRYPTION_KEY;
  if (!encKey) return jsonResponse(500, { error: 'encryption_not_configured' });

  let rows = [];
  if (q) {
    // first try name match
    rows = (await env.CARDS_DB.prepare('SELECT id, name, phone_numbers, created_at FROM cards WHERE name LIKE ?').bind(`%${q}%`).all()).results || [];
    // if q looks like phone or no name-results, also scan phone numbers by decrypting all rows and filter
    const needPhoneSearch = rows.length === 0 || /\+?\d+/.test(q);
    if (needPhoneSearch) {
      const all = (await env.CARDS_DB.prepare('SELECT id, name, phone_numbers, created_at FROM cards').all()).results || [];
      const matched = [];
      for (const r of all) {
        try {
          const j = typeof r.phone_numbers === 'string' ? JSON.parse(r.phone_numbers) : r.phone_numbers;
          const phones = JSON.parse(await decryptText(j.enc, encKey));
          if (phones.some(p => p.includes(q))) matched.push(r);
        } catch (e) {
          continue; // skip rows that fail decryption
        }
      }
      // merge unique results
      const ids = new Set(rows.map(r => r.id));
      for (const m of matched) if (!ids.has(m.id)) rows.push(m);
    }
  } else {
    rows = (await env.CARDS_DB.prepare('SELECT id, name, phone_numbers, created_at FROM cards').all()).results || [];
  }

  const out = [];
  for (const r of rows) {
    try {
      const j = typeof r.phone_numbers === 'string' ? JSON.parse(r.phone_numbers) : r.phone_numbers;
      const phones = JSON.parse(await decryptText(j.enc, encKey));
      out.push({ card_id: r.id, name: r.name, phone_numbers: phones, created_at: r.created_at });
    } catch (e) {
      // skip
    }
  }
  return jsonResponse(200, { results: out });
}

async function safeParseJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}
