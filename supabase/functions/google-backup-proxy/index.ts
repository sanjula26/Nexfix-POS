import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALLOWED_ROLES = new Set(['admin', 'manager']);

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function validScriptUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:'
      && url.hostname === 'script.google.com'
      && /^\/macros\/s\/[^/]+\/(?:exec|dev)\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function bearerToken(req: Request): string {
  const header = req.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

async function authorize(req: Request, shopId: string) {
  const token = bearerToken(req);
  if (!token) return { ok: false as const, status: 401, message: 'Missing user authorization' };
  if (!shopId || shopId.length > 100) return { ok: false as const, status: 400, message: 'Invalid shop id' };

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return { ok: false as const, status: 401, message: 'Invalid or expired session' };

  const { data: membership, error: membershipError } = await supabase
    .from('shop_memberships')
    .select('role')
    .eq('user_id', userData.user.id)
    .eq('shop_id', shopId)
    .eq('active', true)
    .maybeSingle();

  if (membershipError) return { ok: false as const, status: 403, message: 'Unable to verify shop membership' };
  if (!membership || !ALLOWED_ROLES.has(String(membership.role))) {
    return { ok: false as const, status: 403, message: 'Google backup access requires an active admin or manager membership for this shop' };
  }

  return { ok: true as const, token, userId: userData.user.id };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return response({ ok: false, message: 'POST required' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return response({ ok: false, message: 'Invalid JSON body' }, 400);
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const shopId = typeof body.shopId === 'string' ? body.shopId.trim() : '';
  const scriptUrl = typeof body.scriptUrl === 'string' ? body.scriptUrl.trim() : '';
  if (!validScriptUrl(scriptUrl)) {
    return response({ ok: false, message: 'Invalid Google Apps Script Web App URL' }, 400);
  }

  const auth = await authorize(req, shopId);
  if (!auth.ok) return response({ ok: false, message: auth.message }, auth.status);

  const forwarded: Record<string, unknown> = {
    action,
    shopId,
    accessToken: auth.token,
    requestId: typeof body.requestId === 'string' ? body.requestId : crypto.randomUUID(),
  };

  if (action === 'backupState') {
    forwarded.kind = body.kind === 'auto' ? 'auto' : 'manual';
    forwarded.exportedAt = typeof body.exportedAt === 'string' ? body.exportedAt : new Date().toISOString();
    forwarded.state = body.state;
  } else if (action === 'saveData') {
    if (typeof body.table !== 'string' || !Array.isArray(body.rows)) return response({ ok: false, message: 'Invalid saveData payload' }, 400);
    forwarded.table = body.table;
    forwarded.rows = body.rows;
  } else if (action === 'getLatestBackup') {
    // shopId is forwarded so the external backup store can isolate each shop.
  } else if (action === 'getTable') {
    if (typeof body.table !== 'string') return response({ ok: false, message: 'Invalid getTable payload' }, 400);
    forwarded.table = body.table;
  } else {
    return response({ ok: false, message: 'Unsupported Google backup action' }, 400);
  }

  try {
    const upstream = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forwarded),
      redirect: 'follow',
    });
    const text = await upstream.text();
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { payload = { ok: false, message: 'Invalid response from Google Apps Script' }; }
    if (!upstream.ok) return response({ ok: false, message: 'Google Apps Script request failed', upstream: payload }, 502);
    return response(payload);
  } catch (error) {
    return response({ ok: false, message: error instanceof Error ? error.message : 'Google backup request failed' }, 502);
  }
});
