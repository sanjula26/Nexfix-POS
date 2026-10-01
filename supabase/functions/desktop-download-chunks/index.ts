import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const SECRET = KEYS.default || "";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-nexfix-device",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const deviceId = (req.headers.get("x-nexfix-device") || "").trim();
    if (!token || !deviceId || deviceId.length > 200) {
      return json({ ok: false, error: "Authorization and device are required" }, 401);
    }

    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) return json({ ok: false, error: "Invalid authorization" }, 401);
    const userId = userData.user.id;

    const { data: memberships, error: membershipError } = await admin
      .from("shop_memberships")
      .select("shop_id,role")
      .eq("user_id", userId)
      .eq("active", true)
      .limit(10);

    if (membershipError) return json({ ok: false, error: "Could not verify shop membership" }, 500);
    const adminMemberships = (memberships || []).filter((m) => String(m.role) === "admin");
    if (adminMemberships.length !== 1) {
      return json({ ok: false, error: "Only a single active shop-admin account can download the private Windows installer" }, 403);
    }

    const shopId = String(adminMemberships[0].shop_id);
    const { data: existingDevice, error: deviceError } = await admin
      .from("pos_devices")
      .select("shop_id,user_id,revoked_at")
      .eq("device_id", deviceId)
      .maybeSingle();

    if (deviceError) return json({ ok: false, error: "Could not verify downloader device" }, 500);
    if (existingDevice) {
      if (existingDevice.revoked_at || String(existingDevice.user_id) !== userId || String(existingDevice.shop_id) !== shopId) {
        return json({ ok: false, error: "This downloader device is not authorized for this shop" }, 403);
      }
    } else {
      const { error: insertError } = await admin
        .from("pos_devices")
        .insert({ shop_id: shopId, user_id: userId, device_id: deviceId });
      if (insertError) return json({ ok: false, error: "This downloader device could not be authorized" }, 403);
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
      .createSignedUrls(chunkPaths, 1800);

    if (
      signedError ||
      !signed ||
      signed.length !== chunkCount ||
      signed.some((item) => !item.signedUrl)
    ) {
      return json({ ok: false, error: "Could not authorize the complete update download" }, 500);
    }

    return json({
      ok: true,
      mode: "chunks",
      expiresIn: 1800,
      version: release.version,
      name: release.installer_name,
      size: Number(release.installer_size),
      sha512: release.installer_sha512,
      chunks: signed.map((item, index) => ({
        index: index + 1,
        path: chunkPaths[index],
        url: item.signedUrl,
      })),
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Private download authorization failed" }, 500);
  }
});
