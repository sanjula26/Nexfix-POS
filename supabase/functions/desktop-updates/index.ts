import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const URL=Deno.env.get("SUPABASE_URL")!, KEYS=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}"), SECRET=KEYS.default||"";
const admin=createClient(URL,SECRET,{auth:{persistSession:false}});
const headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-nexfix-device","Access-Control-Allow-Methods":"GET,OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,"Content-Type":"application/json"}});
const bearer=(r:Request)=>{const v=r.headers.get("authorization")||"";return v.startsWith("Bearer ")?v.slice(7).trim():"";};
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers});
  if(req.method!=="GET")return json({ok:false,error:"Method not allowed"},405);
  try{
    const token=bearer(req), deviceId=(req.headers.get("x-nexfix-device")||"").trim();
    if(!token||!deviceId)return json({ok:false,error:"Authorization and device are required"},401);
    const {data:u,error:ue}=await admin.auth.getUser(token);
    if(ue||!u.user)return json({ok:false,error:"Invalid authorization"},401);
    // Backward-compatible enrollment for desktop clients that already have a valid
    // Supabase session but were built before client-side device registration.
    const {data:existingRows,error:existingError}=await admin.from("pos_devices").select("shop_id,user_id,revoked_at").eq("device_id",deviceId).limit(10);
    if(existingError)return json({ok:false,error:"Could not verify POS device authorization"},500);
    if((existingRows?.length||0)>1)return json({ok:false,error:"This POS device has ambiguous registrations and must be re-authorized by support"},409);
    const existing=existingRows?.[0]||null;
    let shopId:string;
    let role:string;
    if(existing){
      const {data:members,error:memberError}=await admin.from("shop_memberships").select("shop_id,role").eq("user_id",u.user.id).eq("active",true);
      if(memberError)return json({ok:false,error:"Could not verify shop membership"},500);
      if(!members?.length)return json({ok:false,error:"User is not an active member of a shop"},403);
      if(members.length!==1)return json({ok:false,error:"Multiple active shops require explicit device registration"},403);
      shopId=String(members[0].shop_id);
      role=String(members[0].role||"");
      if(!role)return json({ok:false,error:"Your account is not an active member of this shop"},403);
      const {error:insertError}=await admin.from("pos_devices").insert({shop_id:shopId,user_id:u.user.id,device_id:deviceId});
      if(insertError){
        const {data:racedRows}=await admin.from("pos_devices").select("shop_id,user_id,revoked_at").eq("device_id",deviceId).limit(10);
        if((racedRows?.length||0)!==1)return json({ok:false,error:"This POS device could not be authorized"},403);
        const raced=racedRows[0];
        if(raced.revoked_at || raced.user_id!==u.user.id)return json({ok:false,error:"This POS device could not be authorized"},403);
        shopId=String(raced.shop_id);
      }
    }
    const requestUrl=new URL(req.url);
    const wantsDownload=requestUrl.searchParams.get("download")==="1";
    if(role!=="admin") return json({ok:false,error:"Only the shop admin can use private Windows updater authorization"},403);
    const {data:r,error:re}=await admin.from("desktop_releases").select("version,installer_path,installer_name,installer_sha512,installer_size,published_at").eq("platform","win32").eq("channel","latest").eq("is_active",true).order("published_at",{ascending:false}).limit(1).maybeSingle();
    if(re||!r)return json({ok:false,error:"No authorized Windows update is published"},404);
    const STREAM_CHUNK_BYTES=40*1024*1024;
    const chunkCount=Math.ceil(Number(r.installer_size)/STREAM_CHUNK_BYTES);
    const chunkPaths=Array.from({length:chunkCount},(_,i)=>`${r.installer_path}.part${String(i+1).padStart(4,"0")}`);
    const {data:signed,error:se}=await admin.storage.from("nexfix-desktop-updates").createSignedUrls(chunkPaths,300);
    if(se||!signed?.length||signed.length!==chunkCount||signed.some(x=>!x.signedUrl))return json({ok:false,error:"Could not authorize the complete update download"},500);
    const streamUrl=new URL(req.url); streamUrl.searchParams.set("download","stream");
    streamUrl.pathname=streamUrl.pathname.replace(/\/latest\.(?:yml|yaml)$/,"");
    if(wantsDownload) return json({ok:true,url:streamUrl.toString(),version:r.version,name:r.installer_name,size:r.installer_size,sha512:r.installer_sha512});
    if(requestUrl.searchParams.get("download")==="stream"){
      const body=new ReadableStream({start(controller){(async()=>{try{
        for(const item of signed){
          const upstream=await fetch(item.signedUrl);
          if(!upstream.ok||!upstream.body)throw new Error("Update chunk download failed");
          const reader=upstream.body.getReader();
          while(true){const {done,value}=await reader.read();if(done)break;controller.enqueue(value);}
        }
        controller.close();
      }catch(error){controller.error(error);}})();}});
      return new Response(body,{headers:{...headers,"Content-Type":"application/octet-stream","Content-Length":String(r.installer_size),"Content-Disposition":`attachment; filename="${r.installer_name.replace(/"/g,"")}"`,"Cache-Control":"no-store"}});
    }
    const yaml="version: "+r.version+"\nfiles:\n  - url: "+streamUrl.toString()+"\n    sha512: "+r.installer_sha512+"\n    size: "+r.installer_size+"\nreleaseDate: "+new Date(r.published_at).toISOString()+"\n";
    return new Response(yaml,{headers:{...headers,"Content-Type":"text/yaml; charset=utf-8","Cache-Control":"no-store"}});
  }catch(e){return json({ok:false,error:e instanceof Error?e.message:"Update request failed"},500);}
});
