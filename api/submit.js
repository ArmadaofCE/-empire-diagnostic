// Vercel Edge Function — /api/submit
// Holds Airtable + Kit credentials server-side. The browser never sees them.
// Env vars required (set in Vercel dashboard → Project → Settings → Environment Variables):
//   AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE (optional, defaults to "Leads")
//   KIT_API_KEY, KIT_API_SECRET, KIT_FORM_ID

export const config = { runtime: 'edge' };

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Leads';
const KIT_API_KEY = process.env.KIT_API_KEY;
const KIT_API_SECRET = process.env.KIT_API_SECRET;
const KIT_FORM_ID = process.env.KIT_FORM_ID;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ═══ AIRTABLE — self-healing retry + typecast for select fields ═══ */
async function sendToAirtable(payload, attempt = 0) {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) return { skipped: true, reason: 'not configured' };
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: [{ fields: payload }], typecast: true }),
    }
  );
  const data = await res.json();
  if (data.error) {
    const m = /Unknown field name:\s*\\?"(.+?)\\?"/.exec(data.error.message || '');
    if (data.error.type === 'UNKNOWN_FIELD_NAME' && m && m[1] in payload && attempt < 20) {
      const retry = { ...payload };
      delete retry[m[1]];
      return sendToAirtable(retry, attempt + 1);
    }
    return { error: data.error };
  }
  return { id: data.records?.[0]?.id };
}

/* ═══ KIT — subscribe to form, resolve/create tags, apply tags ═══ */
async function kitFetchTagMap() {
  const res = await fetch(`https://api.convertkit.com/v3/tags?api_key=${KIT_API_KEY}`);
  const data = await res.json();
  const byName = {};
  (data.tags || []).forEach((t) => (byName[t.name] = t.id));
  return byName;
}

async function kitCreateTag(name) {
  const res = await fetch('https://api.convertkit.com/v3/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_secret: KIT_API_SECRET, tag: { name } }),
  });
  const data = await res.json();
  return data.id || data.tag?.id || null;
}

async function kitApplyTag(id, email) {
  const res = await fetch(`https://api.convertkit.com/v3/tags/${id}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_secret: KIT_API_SECRET, email }),
  });
  return res.ok;
}

async function sendToKit(email, name, tags) {
  if (!KIT_API_KEY || !KIT_FORM_ID) return { skipped: true, reason: 'not configured' };

  const subRes = await fetch(
    `https://api.convertkit.com/v3/forms/${KIT_FORM_ID}/subscribe`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: KIT_API_KEY, email, first_name: name }),
    }
  );
  const subData = await subRes.json();
  if (!subRes.ok) return { error: subData };

  const byName = await kitFetchTagMap();
  const results = [];
  for (const tagName of tags || []) {
    let id = byName[tagName];
    if (!id) {
      id = await kitCreateTag(tagName);
      if (!id) {
        results.push({ tag: tagName, ok: false });
        continue;
      }
    }
    const ok = await kitApplyTag(id, email);
    results.push({ tag: tagName, ok });
  }
  return { subscriberId: subData.subscription?.subscriber?.id, tags: results };
}

/* ═══ HANDLER ═══ */
export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { lead, email, name, tags } = body || {};
  if (!lead || typeof lead !== 'object' || !email || !name || !Array.isArray(tags)) {
    return json({ error: 'Missing required fields: lead, email, name, tags[]' }, 400);
  }

  const [airtable, kit] = await Promise.all([
    sendToAirtable(lead).catch((e) => ({ error: String(e) })),
    sendToKit(email, name, tags).catch((e) => ({ error: String(e) })),
  ]);

  return json({ airtable, kit });
}
