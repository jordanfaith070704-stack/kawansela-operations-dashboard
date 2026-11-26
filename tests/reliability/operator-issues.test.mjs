import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

let source = readFileSync(new URL("../../app/api/loyverse/issues/route.ts", import.meta.url), "utf8")
  .replace('import { NextRequest, NextResponse } from "next/server";', 'const NextResponse={json:(body,init)=>new Response(JSON.stringify(body),init)};')
  .replace('import { createClient } from "@/lib/supabase/server";', 'const createClient=async()=>globalThis.__issuesSession;')
  .replace('import { createAdminClient } from "@/lib/supabase/admin";', 'const createAdminClient=()=>{globalThis.__issuesAdminCalls++;return globalThis.__issuesAdmin;};');
const { GET }=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const cart="11111111-1111-1111-1111-111111111111", other="22222222-2222-2222-2222-222222222222";
class Query {
  constructor(rows){this.rows=rows;this.filters=[];this.head=false;this.max=Infinity;}
  select(_fields,opts){this.head=opts?.head;return this;}
  eq(k,v){this.filters.push(r=>r[k]===v);return this;}
  in(k,values){this.filters.push(r=>values.includes(r[k]));return this;}
  is(k,v){this.filters.push(r=>r[k]===v);return this;}
  not(k,_op,v){this.filters.push(r=>r[k]!==v);return this;}
  order(){return this;}
  limit(n){this.max=n;return this;}
  then(resolve,reject){const rows=this.rows.filter(r=>this.filters.every(f=>f(r)));return Promise.resolve({data:this.head?null:rows.slice(0,this.max),count:rows.length,error:null}).then(resolve,reject);}
}
function setup({role="operator",user=true,error=false}={}){
  globalThis.__issuesAdminCalls=0;
  globalThis.__issuesSession={auth:{getUser:async()=>({data:{user:user?{id:"user"}:null},error:null})},from:()=>new Query(error?[]:[{user_id:"user",role,location_id:cart}])};
  const connections=[{id:"conn",location_id:cart,provider:"loyverse",is_active:true,status:"error",last_error:"Loyverse HTTP 402 bearer SECRET",last_successful_sync_at:null,locations:{code:"TEST",name:"Test cart"},secret_reference:"SECRET"},{id:"otherconn",location_id:other,provider:"loyverse",is_active:true,status:"healthy",last_error:null,last_successful_sync_at:new Date().toISOString(),locations:{code:"OTHER",name:"Other cart"}}];
  const events=[{id:"a",pos_connection_id:"conn",external_receipt_id:"R1",event_kind:"refund",received_at:new Date().toISOString(),processed_at:null,processing_error:"raw SECRET",payload:{secret:"SECRET"}},{id:"b",pos_connection_id:"otherconn",external_receipt_id:"PRIVATE",event_kind:"sale",received_at:new Date().toISOString(),processed_at:null,processing_error:"raw SECRET"}];
  globalThis.__issuesAdmin={from:table=>new Query(table==='pos_connections'?connections:events)};
}
const request=id=>({nextUrl:new URL("https://dashboard.example/api/loyverse/issues"+(id===undefined?"":"?locationId="+id))});
test("issues require sign-in before privileged data access",async()=>{setup({user:false});assert.equal((await GET(request(cart))).status,401);assert.equal(globalThis.__issuesAdminCalls,0);});
test("operator cannot request another cart or aggregate all carts",async()=>{setup();assert.equal((await GET(request(other))).status,403);assert.equal((await GET(request())).status,403);assert.equal(globalThis.__issuesAdminCalls,0);});
test("invalid cart IDs are rejected without data access",async()=>{setup();assert.equal((await GET(request('invalid'))).status,400);assert.equal(globalThis.__issuesAdminCalls,0);});
test("operator inbox is scoped and excludes payloads, secret references and raw error text",async()=>{setup();const response=await GET(request(cart));const body=await response.json();assert.equal(response.status,200);assert.equal(body.pendingCount,1);assert.equal(body.issueCount,1);assert.equal(body.issues.length,1);assert.equal(body.issues[0].external_receipt_id,"R1");assert.match(body.issues[0].processing_error,/Refund/);assert.equal(body.connectionIssues.length,1);assert.match(body.connectionIssues[0].message,/riwayat atau langganan/);assert.doesNotMatch(JSON.stringify(body),/SECRET|PRIVATE|secret_reference|payload/);assert.match(response.headers.get('cache-control'),/no-store/);});
test("master aggregate includes all authorized carts",async()=>{setup({role:'master'});const body=await (await GET(request())).json();assert.equal(body.pendingCount,2);assert.equal(body.issues.length,2);});
test("no membership never becomes a privileged inbox read",async()=>{setup({error:true});assert.equal((await GET(request(cart))).status,403);assert.equal(globalThis.__issuesAdminCalls,0);});
