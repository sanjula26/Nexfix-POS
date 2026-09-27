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
    const {data:d}=await admin.from("pos_devices").select("shop_id,user_id").eq("device_id",deviceId).maybeSingle();
    if(!d?.shop_id)return json({ok:false,error:"This POS device is not authorized for updates"},403);
    const {data:m}=await admin.from("shop_memberships").select("role").eq("shop_id",d.shop_id).eq("user_id",u.user.id).eq("active",true).maybeSingle();
    if(!m)return json({ok:false,error:"User is not an active member of this shop"},403);
    const requestUrl=new URL(req.url);
    const wantsDownload=requestUrl.searchParams.get("download")==="1";
    if(wantsDownload && !["admin","manager"].includes(String(m.role))) return json({ok:false,error:"Only an admin or manager can download the Windows installer"},403);
    const {data:r,error:re}=await admin.from("desktop_releases").select("version,installer_path,installer_name,installer_sha512,installer_size,published_at").eq("platform","win32").eq("channel","latest").eq("is_active",true).order("published_at",{ascending:false}).limit(1).maybeSingle();
    if(re||!r)return json({ok:false,error:"No authorized Windows update is published"},404);
    const {data:s,error:se}=await admin.storage.from("nexfix-desktop-updates").createSignedUrl(r.installer_path,300,{download:r.installer_name});
    if(se||!s?.signedUrl)return json({ok:false,error:"Could not authorize the update download"},500);
    if(wantsDownload) return json({ok:true,url:s.signedUrl,version:r.version,name:r.installer_name});
    const yaml="version: "+r.version+"\\nfiles:\\n  - url: "+s.signedUrl+"\\n    sha512: "+r.installer_sha512+"\\n    size: "+r.installer_size+"\\nreleaseDate: "+new Date(r.published_at).toISOString()+"\\n";
    return new Response(yaml,{headers:{...headers,"Content-Type":"text/yaml; charset=utf-8","Cache-Control":"no-store"}});
  }catch(e){return json({ok:false,error:e instanceof Error?e.message:"Update request failed"},500);}
});
