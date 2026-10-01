/* global EdgeRuntime */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!, KEYS=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}"), SECRET=KEYS.default||"";
const admin=createClient(SUPABASE_URL,SECRET,{auth:{persistSession:false}});
const headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-nexfix-device,x-nexfix-update-token","Access-Control-Allow-Methods":"GET,OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,"Content-Type":"application/json"}});
const bearer=(r:Request)=>{const v=r.headers.get("authorization")||"";return v.startsWith("Bearer ")?v.slice(7).trim():"";};
const b64url=(value:string)=>btoa(value).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const fromB64url=(value:string)=>value.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-value.length%4)%4);
const hmacKeyPromise=crypto.subtle.importKey("raw",new TextEncoder().encode(SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
const signDownloadToken=async(payload:string)=>{const key=await hmacKeyPromise;const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(payload));return b64url(String.fromCharCode(...new Uint8Array(sig)));};
const createDownloadToken=async(claims:Record<string,string|number>)=>{const payload=b64url(JSON.stringify(claims));return payload+"."+await signDownloadToken(payload);};
const verifyDownloadToken=async(token:string)=>{try{const [payload,sig]=token.split(".");if(!payload||!sig)return null;const key=await hmacKeyPromise;const sigBytes=Uint8Array.from(atob(fromB64url(sig)),c=>c.charCodeAt(0));const valid=await crypto.subtle.verify("HMAC",key,sigBytes,new TextEncoder().encode(payload));if(!valid)return null;const claims=JSON.parse(atob(fromB64url(payload)));if(!claims||typeof claims!=="object"||Number(claims.exp)<=Math.floor(Date.now()/1000))return null;return claims as Record<string,unknown>;}catch{return null;}};
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers});
  if(req.method!=="GET")return json({ok:false,error:"Method not allowed"},405);
  try{
    const requestUrl=new URL(req.url);
    const wantsDownload=requestUrl.searchParams.get("download")==="1";
    const signedDownloadToken=(requestUrl.searchParams.get("token")||"").trim();
    const isStreamDownload=requestUrl.pathname.endsWith("/download") || /\/download\/[^/]+\.exe$/i.test(requestUrl.pathname);
    const signedClaims=(signedDownloadToken && isStreamDownload)?await verifyDownloadToken(signedDownloadToken):null;
    const token=bearer(req), deviceToken=(req.headers.get("x-nexfix-update-token")||"").trim(), deviceId=(req.headers.get("x-nexfix-device")||"").trim() || String(signedClaims?.deviceId||"");
    if(!deviceId)return json({ok:false,error:"Authorization and device are required"},401);
    let shopId:string;
    let role:string;
    let authenticatedUserId:string;
    if(signedClaims){
      if(String(signedClaims.deviceId)!==deviceId)return json({ok:false,error:"Invalid private download authorization"},401);
      const {data:device,error:deviceError}=await admin.from("pos_devices").select("shop_id,user_id,revoked_at").eq("device_id",deviceId).maybeSingle();
      if(deviceError)return json({ok:false,error:"Could not verify POS device authorization"},500);
      if(!device || device.revoked_at || String(device.shop_id)!==String(signedClaims.shopId) || String(device.user_id)!==String(signedClaims.userId))return json({ok:false,error:"This private download authorization is no longer valid"},403);
      authenticatedUserId=String(device.user_id); shopId=String(device.shop_id);
      const {data:membership,error:membershipError}=await admin.from("shop_memberships").select("role").eq("shop_id",shopId).eq("user_id",authenticatedUserId).eq("active",true).maybeSingle();
      if(membershipError)return json({ok:false,error:"Could not verify shop membership"},500);
      if(!membership?.role)return json({ok:false,error:"User is not an active member of this shop"},403);
      role=String(membership.role);
    }else if(deviceToken){    if(role!=="admin") return json({ok:false,error:"Only the shop admin can use private Windows updater authorization"},403);
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
    const streamUrl=new URL(SUPABASE_URL+"/functions/v1/desktop-updates/download/"+encodeURIComponent(r.installer_name));
    if(wantsDownload){
      const claims={deviceId,shopId,userId:authenticatedUserId,version:r.version,exp:Math.floor(Date.now()/1000)+600};
      const downloadToken=await createDownloadToken(claims);
      const privateUrl=new URL(streamUrl.toString());
      privateUrl.searchParams.set("token",downloadToken);
      return json({ok:true,url:privateUrl.toString(),expiresIn:600,version:r.version,name:r.installer_name,size:r.installer_size,sha512:r.installer_sha512});
    }
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
