import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const SECRET = SECRET_KEYS.default || "";
const admin = createClient(URL, SECRET, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-nexfix-action", "Access-Control-Allow-Methods":"GET,POST,OPTIONS", "Content-Type":"application/json" };
const json = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers:cors});
const bearer = (req: Request) => { const v=req.headers.get("authorization")||""; return v.startsWith("Bearer ") ? v.slice(7).trim() : ""; };
function base64Url(bytes: Uint8Array) { let s=""; for(const b of bytes)s+=String.fromCharCode(b); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
async function sha256(value:string) { return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))); }
async function userId(req:Request) { const token=bearer(req); if(!token) throw new Error("Missing authorization"); const {data,error}=await admin.auth.getUser(token); if(error||!data.user) throw new Error("Invalid authorization"); return data.user.id; }
function bounds(date:string,tz:string) {
  const safe=/^\d{4}-\d{2}-\d{2}$/.test(date)?date:new Date().toISOString().slice(0,10);
  if(!tz)return {start:safe+"T00:00:00.000Z",end:safe+"T23:59:59.999Z"};
  const offset=(d:Date)=>{const p=new Intl.DateTimeFormat("en-US",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(d);const n=(t:string)=>Number(p.find(x=>x.type===t)?.value||0);return Math.round((Date.UTC(n("year"),n("month")-1,n("day"),n("hour"),n("minute"),n("second"))-d.getTime())/60000);};
  const conv=(time:string)=>{const g=new Date(safe+"T"+time+"Z");return new Date(g.getTime()-offset(g)*60000).toISOString();};
  return {start:conv("00:00:00.000"),end:conv("23:59:59.999")};
}
async function create(req:Request) {
  const uid=await userId(req), body=await req.json().catch(()=>({})), shopId=String(body.shopId||"").trim();
  if(!shopId)return json({ok:false,error:"Shop is required"},400);
  const {data:m}=await admin.from("shop_memberships").select("role").eq("shop_id",shopId).eq("user_id",uid).eq("active",true).maybeSingle();
  if(!m||!["admin","manager"].includes(String(m.role)))return json({ok:false,error:"Only an active shop admin or manager can create a phone sales link"},403);
  const oldToken=String(body.oldToken||"").trim();
  if(oldToken){
    const oldHash=await sha256(oldToken);
    await admin.from("phone_sales_tokens").update({revoked_at:new Date().toISOString()}).eq("token_hash",oldHash).eq("shop_id",shopId).is("revoked_at",null);
  }
  const token=base64Url(crypto.getRandomValues(new Uint8Array(32))), hash=await sha256(token);
  const {error}=await admin.from("phone_sales_tokens").insert({token_hash:hash,shop_id:shopId,device_id:String(body.deviceId||"").trim().slice(0,200)||null,created_by:uid,label:String(body.label||"Phone Sales").trim().slice(0,80)||"Phone Sales"});
  if(error)return json({ok:false,error:error.message},400);
  return json({ok:true,token});
}
async function revoke(req:Request) {
  const uid=await userId(req), body=await req.json().catch(()=>({})), token=String(body.token||"").trim();
  if(!token)return json({ok:false,error:"Token is required"},400);
  const hash=await sha256(token), {data:row}=await admin.from("phone_sales_tokens").select("id,shop_id").eq("token_hash",hash).maybeSingle();
  if(!row)return json({ok:false,error:"Token not found"},404);
  const {data:m}=await admin.from("shop_memberships").select("role").eq("shop_id",row.shop_id).eq("user_id",uid).eq("active",true).maybeSingle();
  if(!m||!["admin","manager"].includes(String(m.role)))return json({ok:false,error:"Not authorized"},403);
  const {error}=await admin.from("phone_sales_tokens").update({revoked_at:new Date().toISOString()}).eq("id",row.id);
  if(error)return json({ok:false,error:error.message},400); return json({ok:true});
}
async function read(req:Request) {
  const u=new URL(req.url), token=(u.searchParams.get("token")||"").trim();
  if(token.length<32)return json({ok:false,error:"Invalid phone sales link"},401);
  const hash=await sha256(token), {data:g}=await admin.from("phone_sales_tokens").select("id,shop_id,device_id,expires_at,revoked_at").eq("token_hash",hash).maybeSingle();
  if(!g||g.revoked_at||(g.expires_at&&new Date(g.expires_at).getTime()<=Date.now()))return json({ok:false,error:"This phone sales link is expired or revoked"},401);
  await admin.from("phone_sales_tokens").update({last_used_at:new Date().toISOString()}).eq("id",g.id);
  const {start,end}=bounds((u.searchParams.get("date")||"").trim(),(u.searchParams.get("tz")||"").trim());
  const {data:sales,error:se}=await admin.from("sales").select("id,shop_id,bill_no,customer_id,customer_name,cashier_id,cashier_name,subtotal,discount,tax,shipping,total,amount_paid,change_amount,profit,points_earned,points_redeemed,status,note,created_at").eq("shop_id",g.shop_id).gte("created_at",start).lte("created_at",end).order("created_at",{ascending:false}).limit(500);
  if(se)return json({ok:false,error:se.message},500);
  const ids=(sales||[]).map(s=>s.id);
  const items=ids.length?(await admin.from("sale_items").select("id,sale_id,product_id,name,qty,price,cost,discount,price_overridden,warranty_months,unit_ids").in("sale_id",ids)).data||[]:[];
  const pays=ids.length?(await admin.from("sale_payments").select("id,sale_id,method,amount").in("sale_id",ids)).data||[]:[];
  const im=new Map<string,any[]>(), pm=new Map<string,any[]>();
  for(const x of items){const a=im.get(x.sale_id)||[];a.push({productId:String(x.product_id),name:String(x.name||"Item"),qty:Number(x.qty||0),price:Number(x.price||0),cost:Number(x.cost||0),discount:Number(x.discount||0),priceOverridden:x.price_overridden===true||undefined,warrantyMonths:Number(x.warranty_months||0)||undefined,unitIds:Array.isArray(x.unit_ids)&&x.unit_ids.length?x.unit_ids.map(String):undefined});im.set(x.sale_id,a);}
  for(const x of pays){const a=pm.get(x.sale_id)||[];a.push({method:String(x.method),amount:Number(x.amount||0)});pm.set(x.sale_id,a);}
  return json({ok:true,shopId:g.shop_id,authorizedDeviceId:g.device_id,date:u.searchParams.get("date")||"",sales:(sales||[]).map(s=>{const legs=pm.get(s.id)||[];return {id:String(s.id),billNo:String(s.bill_no||""),date:String(s.created_at),cashierId:String(s.cashier_id||""),cashierName:String(s.cashier_name||""),customerId:s.customer_id?String(s.customer_id):undefined,customerName:String(s.customer_name||"Walk-in customer"),items:im.get(s.id)||[],subtotal:Number(s.subtotal||0),discount:Number(s.discount||0),tax:Number(s.tax||0),shipping:Number(s.shipping||0),total:Number(s.total||0),amountPaid:Number(s.amount_paid||0),change:Number(s.change_amount||0),profit:Number(s.profit||0),pointsEarned:Number(s.points_earned||0)||undefined,pointsRedeemed:Number(s.points_redeemed||0)||undefined,note:s.note?String(s.note):undefined,status:String(s.status||"completed"),payment:legs[0]?.method||"cash",payments:legs.length>1?legs:undefined};})});
}
Deno.serve(async req=>{if(req.method==="OPTIONS")return new Response("ok",{headers:cors});try{if(req.method==="GET")return await read(req);if(req.method==="POST")return (req.headers.get("x-nexfix-action")||"").toLowerCase()==="revoke"?await revoke(req):await create(req);return json({ok:false,error:"Method not allowed"},405);}catch(e){return json({ok:false,error:e instanceof Error?e.message:"Request failed"},500);}});
