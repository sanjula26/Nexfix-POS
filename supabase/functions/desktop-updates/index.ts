/* global EdgeRuntime */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!, KEYS=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}"), SECRET=KEYS.default||"";
const admin=createClient(SUPABASE_URL,SECRET,{auth:{persistSession:false}});
const headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-nexfix-device,x-nexfix-update-token","Access-Control-Allow-Methods":"GET,OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,"Content-Type":"application/json"}});
const bearer=(r:Request)=>{const v=r.headers.get("authorization")||"";return v.startsWith("Bearer ")?v.slice(7).trim():"";};
const b64url=(value:string)=>value.replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const fromB64url=(value:string)=>value.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-value.length%4)%4);
const tokenText=(value:string)=>b64url(btoa(unescape(encodeURIComponent(value))));
const decodeTokenText=(value:string)=>decodeURIComponent(escape(atob(fromB64url(value))));
const hmacKeyPromise=crypto.subtle.importKey("raw",new TextEncoder().encode(SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
const signDownloadToken=async(payload:string)=>{const key=await hmacKeyPromise;const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(payload));return b64url(btoa(String.fromCharCode(...new Uint8Array(sig))));};
const createDownloadToken=async(claims:Record<string,string|number>)=>{const payload=tokenText(JSON.stringify(claims));return payload+"."+await signDownloadToken(payload);};
const verifyDownloadToken=async(token:string)=>{try{const [payload,sig]=token.split(".");if(!payload||!sig)return null;const key=await hmacKeyPromise;const sigBytes=Uint8Array.from(atob(fromB64url(sig)),c=>c.charCodeAt(0));const valid=await crypto.subtle.verify("HMAC",key,sigBytes,new TextEncoder().encode(payload));if(!valid)return null;const claims=JSON.parse(decodeTokenText(payload));if(!claims||typeof claims!=="object"||Number(claims.exp)<=Math.floor(Date.now()/1000))return null;return claims as Record<string,unknown>;}catch{return null;}};
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers});
  if(req.method!=="GET")return json({ok:false,error:"Method not allowed"},405);
  try{
    const token=bearer(req), deviceToken=(req.headers.get("x-nexfix-update-token")||"").trim(), deviceId=(req.headers.get("x-nexfix-device")||"").trim();
    if(!deviceId)return json({ok:false,error:"Authorization and device are required"},401);

    let shopId:string;
    let role:string;
    let authenticatedUserId:string;

    if(signedClaims){
      if(String(signedClaims.deviceId)!==deviceId)return json({ok:false,error:"Invalid private download authorization"},401);
      const {data:device,error:deviceError}=await admin.from("pos_devices").select("shop_id,user_id,revoked_at").eq("device_id",deviceId).maybeSingle();
      if(deviceError)return json({ok:false,error:"Could not verify POS device authorization"},500);
      if(!device || device.revoked_at || String(device.shop_id)!==String(signedClaims.shopId) || String(device.user_id)!==String(signedClaims.userId))return json({ok:false,error:"This private download authorization is no longer valid"},403);
      authenticatedUserId=String(device.user_id);
      shopId=String(device.shop_id);
      const {data:membership,error:membershipError}=await admin.from("shop_memberships").select("role").eq("shop_id",shopId).eq("user_id",authenticatedUserId).eq("active",true).maybeSingle();
      if(membershipError)return json({ok:false,error:"Could not verify shop membership"},500);
      if(!membership?.role)return json({ok:false,error:"User is not an active member of this shop"},403);
      role=String(membership.role);
    }else if(deviceToken){
      // One-time authorized machines use a dedicated high-entropy device token.
      // This path is independent of the Supabase interactive session, so normal
      // POS logout, refresh-token rotation, and cashier/admin switching do not
      // revoke future private updates.
      if(deviceToken.length<64 || deviceToken.length>512)return json({ok:false,error:"Invalid updater device credential"},401);
      const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(deviceToken));
      const tokenHash=Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
      const {data:device,error:deviceError}=await admin.from("pos_devices").select("shop_id,user_id,revoked_at").eq("device_id",deviceId).eq("updater_token_hash",tokenHash).maybeSingle();
      if(deviceError)return json({ok:false,error:"Could not verify POS device authorization"},500);
      if(!device)return json({ok:false,error:"This Windows PC is not authorized for private updates"},401);
      if(device.revoked_at)return json({ok:false,error:"This POS device has been revoked and must be re-authorized by support"},403);
      authenticatedUserId=String(device.user_id);
      shopId=String(device.shop_id);
      const {data:membership,error:membershipError}=await admin.from("shop_memberships").select("role").eq("shop_id",shopId).eq("user_id",authenticatedUserId).eq("active",true).maybeSingle();
      if(membershipError)return json({ok:false,error:"Could not verify shop membership"},500);
      if(!membership?.role)return json({ok:false,error:"User is not an active member of this shop"},403);
      role=String(membership.role);
    }else{
      if(!token)return json({ok:false,error:"Authorization and device are required"},401);
      const {data:u,error:ue}=await admin.auth.getUser(token);
      if(ue||!u.user)return json({ok:false,error:"Invalid authorization"},401);
      authenticatedUserId=u.user.id;
      // Backward-compatible enrollment for desktop clients that already have a valid
      // Supabase session but were built before client-side device registration.
      const {data:existingRows,error:existingError}=await admin.from("pos_devices").select("shop_id,user_id,revoked_at").eq("device_id",deviceId).limit(10);
      if(existingError)return json({ok:false,error:"Could not verify POS device authorization"},500);
      if((existingRows?.length||0)>1)return json({ok:false,error:"This POS device has ambiguous registrations and must be re-authorized by support"},409);
      const existing=existingRows?.[0]||null;
      if(existing){
        // Existing registrations are authoritative: never re-insert the same
        // device and never allow a different user to take over a registered ID.
        if(existing.revoked_at)return json({ok:false,error:"This POS device has been revoked and must be re-authorized by support"},403);
        if(existing.user_id!==authenticatedUserId)return json({ok:false,error:"This POS device is registered to a different cloud account"},403);
        shopId=String(existing.shop_id);
        const {data:membership,error:membershipError}=await admin.from("shop_memberships").select("role").eq("shop_id",shopId).eq("user_id",authenticatedUserId).eq("active",true).maybeSingle();
        if(membershipError)return json({ok:false,error:"Could not verify shop membership"},500);
        if(!membership?.role)return json({ok:false,error:"User is not an active member of this shop"},403);
        role=String(membership.role);
      }else{
        // First-time/backward-compatible enrollment: bind the new device only
        // when the authenticated account has exactly one active shop.
        const {data:members,error:memberError}=await admin.from("shop_memberships").select("shop_id,role").eq("user_id",authenticatedUserId).eq("active",true);
        if(memberError)return json({ok:false,error:"Could not verify shop membership"},500);
        if(!members?.length)return json({ok:false,error:"User is not an active member of a shop"},403);
        if(members.length!==1)return json({ok:false,error:"Multiple active shops require explicit device registration"},403);
        shopId=String(members[0].shop_id);
        role=String(members[0].role||"");
        if(!role)return json({ok:false,error:"Your account is not an active member of this shop"},403);
        const {error:shopError}=await admin.from("pos_shops").upsert({shop_id:shopId,created_by:authenticatedUserId},{onConflict:"shop_id",ignoreDuplicates:true});
        if(shopError)return json({ok:false,error:"Could not initialize the POS shop authorization"},500);
        const {error:insertError}=await admin.from("pos_devices").insert({shop_id:shopId,user_id:authenticatedUserId,device_id:deviceId});
        if(insertError){
          const {data:racedRows}=await admin.from("pos_devices").select("shop_id,user_id,revoked_at").eq("device_id",deviceId).limit(10);
          if((racedRows?.length||0)!==1)return json({ok:false,error:"This POS device could not be authorized"},403);
          const raced=racedRows[0];
          if(raced.revoked_at || raced.user_id!==authenticatedUserId)return json({ok:false,error:"This POS device could not be authorized"},403);
          shopId=String(raced.shop_id);
          const {data:racedMembership,error:racedMembershipError}=await admin.from("shop_memberships").select("role").eq("shop_id",shopId).eq("user_id",authenticatedUserId).eq("active",true).maybeSingle();
          if(racedMembershipError)return json({ok:false,error:"Could not verify shop membership"},500);
          if(!racedMembership?.role)return json({ok:false,error:"User is not an active member of this shop"},403);
          role=String(racedMembership.role);
        }
      }
    }
    const requestUrl=new URL(req.url);
    const wantsDownload=requestUrl.searchParams.get("download")==="1";
    const isStreamDownload=requestUrl.pathname.endsWith("/download") || /\/download\/[^/]+\.exe$/i.test(requestUrl.pathname);
    if(role!=="admin") return json({ok:false,error:"Only the shop admin can use private Windows updater authorization"},403);
    const {data:r,error:re}=await admin.from("desktop_releases").select("version,installer_path,installer_name,installer_sha512,installer_size,published_at").eq("platform","win32").eq("channel","latest").eq("is_active",true).order("published_at",{ascending:false}).limit(1).maybeSingle();
    if(re||!r)return json({ok:false,error:"No authorized Windows update is published"},404);
    const STREAM_CHUNK_BYTES=40*1024*1024;
    const chunkCount=Math.ceil(Number(r.installer_size)/STREAM_CHUNK_BYTES);
    const chunkPaths=Array.from({length:chunkCount},(_,i)=>`${r.installer_path}.part${String(i+1).padStart(4,"0")}`);
    const {data:signed,error:se}=await admin.storage.from("nexfix-desktop-updates").createSignedUrls(chunkPaths,900);
    if(se||!signed?.length||signed.length!==chunkCount||signed.some(x=>!x.signedUrl))return json({ok:false,error:"Could not authorize the complete update download"},500);
    // The updater expects the manifest file URL to have an installer-like filename.
    // A query-only stream URL can be treated as a cache filename such as
    // `temp-desktop-updates?download=stream`, which breaks electron-updater on Windows.
    const streamUrl=new URL(`${SUPABASE_URL}/functions/v1/desktop-updates/download/${encodeURIComponent(r.installer_name)}`);
    if(wantsDownload) return json({ok:true,url:streamUrl.toString(),chunks:signed.map(x=>x.signedUrl),version:r.version,name:r.installer_name,size:r.installer_size,sha512:r.installer_sha512});
    if(isStreamDownload){
      // Keep the edge worker explicitly alive for the entire downstream stream.
      // A detached ReadableStream producer can be retired while Electron is still
      // downloading, which surfaces as a network/QUIC protocol error mid-file.
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const streamTask = (async () => {
        const writer = writable.getWriter();
        try {
          for(const item of signed){
            const upstream = await fetch(item.signedUrl, { cache: "no-store" });
            if(!upstream.ok || !upstream.body) throw new Error(`Update chunk download failed (${upstream.status})`);
            const reader = upstream.body.getReader();
            try {
              while(true){
                const {done,value}=await reader.read();
                if(done) break;
                await writer.write(value);
              }
            } finally {
              reader.releaseLock();
            }
          }
          await writer.close();
        } catch(error) {
          try { await writer.abort(error); } catch (abortError) { console.error("Private updater stream abort failed:", abortError); }
          throw error;
        }
      })();
      EdgeRuntime.waitUntil(streamTask.catch(error => console.error("Private updater stream failed:", error)));
      return new Response(readable,{
        headers:{
          ...headers,
          "Content-Type":"application/octet-stream",
          "Content-Length":String(r.installer_size),
          "Content-Disposition":`attachment; filename="${r.installer_name.replace(/"/g,"")}"`,
          "Cache-Control":"no-store"
        }
      });
    }
    const yaml="version: "+r.version+"\nfiles:\n  - url: "+streamUrl.toString()+"\n    sha512: "+r.installer_sha512+"\n    size: "+r.installer_size+"\nreleaseDate: "+new Date(r.published_at).toISOString()+"\n";
    return new Response(yaml,{headers:{...headers,"Content-Type":"text/yaml; charset=utf-8","Cache-Control":"no-store"}});
  }catch(e){return json({ok:false,error:e instanceof Error?e.message:"Update request failed"},500);}
});
