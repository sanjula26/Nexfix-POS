/* global EdgeRuntime */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { S3Client, GetObjectCommand } from "npm:@aws-sdk/client-s3@3.901.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.901.0";
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!, KEYS=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}"), SECRET=KEYS.default||"";
const R2_ACCOUNT_ID=(Deno.env.get("R2_ACCOUNT_ID")||"").trim();
const R2_ACCESS_KEY_ID=(Deno.env.get("R2_ACCESS_KEY_ID")||"").trim();
const R2_SECRET_ACCESS_KEY=(Deno.env.get("R2_SECRET_ACCESS_KEY")||"").trim();
const R2_BUCKET=(Deno.env.get("R2_BUCKET")||"nexfix-desktop-updates").trim();
const R2_CONFIG_PRESENCE={accountId:Boolean(R2_ACCOUNT_ID),accessKeyId:Boolean(R2_ACCESS_KEY_ID),secretAccessKey:Boolean(R2_SECRET_ACCESS_KEY),bucket:Boolean(R2_BUCKET)};
console.log("desktop-updates R2 configuration presence",R2_CONFIG_PRESENCE);
const admin=createClient(SUPABASE_URL,SECRET,{auth:{persistSession:false}});
const r2=(R2_ACCOUNT_ID&&R2_ACCESS_KEY_ID&&R2_SECRET_ACCESS_KEY&&R2_BUCKET) ? new S3Client({region:"auto",endpoint:"https://"+R2_ACCOUNT_ID+".r2.cloudflarestorage.com",credentials:{accessKeyId:R2_ACCESS_KEY_ID,secretAccessKey:R2_SECRET_ACCESS_KEY}}) : null;
const R2_SIGNED_URL_SECONDS=15*60;
const getR2DownloadUrl=async(key:string,name:string)=>{
  if(!r2||!R2_BUCKET) throw new Error("Private installer storage is not configured");
  return await getSignedUrl(r2,new GetObjectCommand({Bucket:R2_BUCKET,Key:key,ResponseContentType:"application/octet-stream",ResponseContentDisposition:"attachment; filename=\"" + name.replace(/"/g,"") + "\"",ResponseCacheControl:"no-store"}),{expiresIn:R2_SIGNED_URL_SECONDS});
};
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
    if(role!=="admin") return json({ok:false,error:"Only the shop admin can use private Windows updater authorization"},403);
    const {data:r,error:re}=await admin.from("desktop_releases").select("version,installer_path,installer_name,installer_sha512,installer_size,published_at").eq("platform","win32").eq("channel","latest").eq("is_active",true).order("published_at",{ascending:false}).limit(1).maybeSingle();
    if(re||!r)return json({ok:false,error:"No authorized Windows update is published"},404);
    const r2Url=await getR2DownloadUrl(String(r.installer_path),String(r.installer_name));
    const wantsChunkManifest=wantsDownload && requestUrl.searchParams.get("mode")==="chunks";
    if(wantsChunkManifest){
      return json({ok:true,mode:"object",expiresIn:R2_SIGNED_URL_SECONDS,version:r.version,name:r.installer_name,size:Number(r.installer_size),sha512:r.installer_sha512,url:r2Url});
    }
    if(wantsDownload){
      return json({ok:true,mode:"object",url:r2Url,expiresIn:R2_SIGNED_URL_SECONDS,version:r.version,name:r.installer_name,size:r.installer_size,sha512:r.installer_sha512});
    }
    if(isStreamDownload){
      return Response.redirect(r2Url,307);
    }
    const yaml="version: "+r.version+"\nfiles:\n  - url: "+r2Url+"\n    sha512: "+r.installer_sha512+"\n    size: "+r.installer_size+"\nreleaseDate: "+new Date(r.published_at).toISOString()+"\n";
    return new Response(yaml,{headers:{...headers,"Content-Type":"text/yaml; charset=utf-8","Cache-Control":"no-store"}});
  }catch(e){return json({ok:false,error:e instanceof Error?e.message:"Update request failed"},500);}
});
