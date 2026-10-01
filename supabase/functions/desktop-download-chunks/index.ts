import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const SECRET = KEYS.default || "";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-nexfix-device,x-nexfix-update-token",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

const bearer = (req: Request) => {
  const value = req.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
};

async function authenticate(req: Request, deviceId: string): Promise<{ ok: true; userId: string; shopId: string } | { ok: false; response: Response }> {
  const deviceToken = (req.headers.get("x-nexfix-update-token") || "").trim();
  const token = bearer(req);

  if (deviceToken) {
    if (deviceToken.length < 64 || deviceToken.length > 512) {
      return { ok: false, response: json({ ok: false, error: "Invalid updater device credential" }, 401) };
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceToken));
    const tokenHash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
    const { data: device, error } = await admin
      .from("pos_devices")
      .select("shop_id,user_id,revoked_at")
      .eq("device_id", deviceId)
      .eq("updater_token_hash", tokenHash)
      .maybeSingle();
    if (error) return { ok: false, response: json({ ok: false, error: "Could not verify POS device authorization" }, 500) };
    if (!device) return { ok: false, response: json({ ok: false, error: "This Windows PC is not authorized for private updates" }, 401) };
    if (device.revoked_at) return { ok: false, response: json({ ok: false, error: "This POS device has been revoked and must be re-authorized by support" }, 403) };
    return { ok: true, userId: String(device.user_id), shopId: String(device.shop_id) };
  }

  if (!token) return { ok: false, response: json({ ok: false, error: "Authorization and device are required" }, 401) };
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData.user) return { ok: false, response: json({ ok: false, error: "Invalid authorization" }, 401) };

  const { data: memberships, error: membershipError } = await admin
    .from("shop_memberships")
    .select("shop_id,role")
    .eq("user_id", userData.user.id)
    .eq("active", true)
    .limit(10);
  if (membershipError) return { ok: false, response: json({ ok: false, error: "Could not verify shop membership" }, 500) };

  const admins = (memberships || []).filter(m => String(m.role) === "admin");
  if (admins.length !== 1) {
    return { ok: false, response: json({ ok: false, error: "Only a single active shop-admin account can download the private Windows installer" }, 403) };
  }

  const shopId = String(admins[0].shop_id);
  const { data: device, error: deviceError } = await admin
    .from("pos_devices")
    .select("shop_id,user_id,revoked_at")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (deviceError) return { ok: false, response: json({ ok: false, error: "Could not verify downloader device" }, 500) };
  if (device && (device.revoked_at || String(device.user_id) !== userData.user.id || String(device.shop_id) !== shopId)) {
    return { ok: false, response: json({ ok: false, error: "This downloader device is not authorized for this shop" }, 403) };
  }
  if (!device) {
    const { error: insertError } = await admin.from("pos_devices").insert({ shop_id: shopId, user_id: userData.user.id, device_id: deviceId });
    if (insertError) return { ok: false, response: json({ ok: false, error: "This downloader device could not be authorized" }, 403) };
  }

  return { ok: true, userId: userData.user.id, shopId };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const deviceId = (req.headers.get("x-nexfix-device") || "").trim();
    if (!deviceId || deviceId.length > 200) return json({ ok: false, error: "Authorization and device are required" }, 401);

    const auth = await authenticate(req, deviceId);
    if (!auth.ok) return auth.response;

    const { data: membership, error: membershipError } = await admin
      .from("shop_memberships")
      .select("role")
      .eq("shop_id", auth.shopId)
      .eq("user_id", auth.userId)
      .eq("active", true)
      .maybeSingle();
    if (membershipError) return json({ ok: false, error: "Could not verify shop membership" }, 500);
    if (String(membership?.role || "") !== "admin") {
      return json({ ok: false, error: "Only the shop admin can download the private Windows installer" }, 403);
    }

    const { data: release, error: releaseError } = await admin
      .from("desktop_releases")
      .select("version,installer_path,installer_name,installer_sha512,installer_size,published_at")
      .eq("platform", "win32")
      .eq("channel", "latest")
      .eq("is_active", true)
      .order("published_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (releaseError || !release) return json({ ok: false, error: "No authorized Windows update is published" }, 404);

    const chunkBytes = 40 * 1024 * 1024;
    const chunkCount = Math.ceil(Number(release.installer_size) / chunkBytes);
    const chunkPaths = Array.from(
      { length: chunkCount },
      (_, i) => `${release.installer_path}.part${String(i + 1).padStart(4, "0")}`,
    );

    const { data: signed, error: signedError } = await admin.storage
      .from("nexfix-desktop-updates")
      .createSignedUrls(chunkPaths, 900);

    if (signedError || !signed || signed.length !== chunkCount || signed.some(item => !item.signedUrl)) {
      return json({ ok: false, error: "Could not authorize the complete update download" }, 500);
    }

    return json({
      ok: true,
      mode: "chunks",
      expiresIn: 900,
      version: release.version,
      name: release.installer_name,
      size: Number(release.installer_size),
      sha512: release.installer_sha512,
      chunks: signed.map((item, index) => ({ index: index + 1, path: chunkPaths[index], url: item.signedUrl })),
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Private download authorization failed" }, 500);
  }
});
