import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function load(file, mocks = {}) {
  const context = vm.createContext({ exports: {}, require: n => mocks[n] ?? require(n), Buffer, URL, Request, Response, Headers, ReadableStream, TextEncoder, AbortController, setInterval, clearInterval, setTimeout, clearTimeout });
  vm.runInContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.exports;
}
const media = load('src/lib/conversation-media.ts');
const id = '11111111-1111-4111-8111-111111111111';
const bytes = Buffer.alloc(6 * 1024 * 1024, 42);
const body = JSON.stringify({kind:'media',mediaKind:'audio',mimeType:'audio/mpeg',fileName:'audio.mp3',caption:'Preservar legenda',dataUrl:`data:audio/mpeg;base64,${bytes.toString('base64')}`});
const light = media.lightweightMessageBody(id, body);
assert.ok(Buffer.byteLength(light) < 400);
assert.equal(JSON.parse(light).caption,'Preservar legenda');
assert.equal(JSON.parse(light).dataUrl,`/api/conversations/media/${id}`);
assert.equal(media.lightweightMessageBody(id,'Texto original'),'Texto original');
assert.equal(media.lightweightMessageBody(id,'x'.repeat(800),true).length,500);
assert.equal(media.conversationMedia('{broken'),null);
assert.ok(JSON.parse(body).dataUrl.length > 8_000_000, 'Stored attachment preserved');
let user={id:'owner',role:'EMPLOYEE'}, deleted=false, calls=0;
const route=load('src/app/api/conversations/media/[messageId]/route.ts',{
 '@/lib/conversation-media':media,
 '@/lib/auth-context':{requireCurrentUser:async()=>{if(!user)throw Error('UNAUTHORIZED');return user;}},
 '@/lib/api-errors':{authErrorResponse:e=>e.message==='UNAUTHORIZED'?new Response(null,{status:401}):null},
 '@/lib/prisma':{prisma:{chatMessage:{findFirst:async({where})=>{calls++;assert.equal(where.conversation.deletedAt,null);return !deleted && (user.role==='ADMIN'||where.conversation.ownerUserId==='owner')?{body}:null;}}}},
});
const get=(headers={})=>route.GET(new Request('https://local/media',{headers}),{params:Promise.resolve({messageId:id})});
let response=await get();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-cache');assert.equal(response.headers.get('vary'),'Cookie');assert.equal((await response.arrayBuffer()).byteLength,bytes.length);
const etag=response.headers.get('etag');response=await get({'if-none-match':etag});assert.equal(response.status,304);assert.equal(await response.text(),'');
response=await get({range:'bytes=100-199'});assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,100);assert.equal(response.headers.get('content-range'),`bytes 100-199/${bytes.length}`);
response=await get({range:'bytes=-10'});assert.equal((await response.arrayBuffer()).byteLength,10);
response=await get({range:'bytes=99999999-'});assert.equal(response.status,416);
user={id:'someone-else',role:'EMPLOYEE'};assert.equal((await get({'if-none-match':etag})).status,404,'Permissions precede cache validation');
user={id:'admin',role:'ADMIN'};deleted=true;assert.equal((await get()).status,404);deleted=false;
user=null;const before=calls;assert.equal((await get()).status,401);assert.equal(calls,before);
const cached=load('src/lib/private-json-response.ts');const first=cached.privateJsonResponse(new Request('https://local'),{data:{message:'ok'},timestamp:'one'});const same=cached.privateJsonResponse(new Request('https://local',{headers:{'if-none-match':first.headers.get('etag')}}),{data:{message:'ok'},timestamp:'two'});assert.equal(same.status,304);assert.equal(cached.privateJsonResponse(new Request('https://local',{headers:{'if-none-match':first.headers.get('etag')}}),{data:{message:'changed'}}).status,200);
const client=new EventEmitter();client.connect=async()=>{};client.query=async()=>{};client.end=async()=>{};
const streaming=load('src/server/realtime/conversation-stream.ts',{'./conversation-events':{createConversationListener:()=>client,getConversationChannelName:()=> 'test'}});
const abort=new AbortController();const stream=await streaming.openConversationStream(abort.signal,60000);const reader=stream.getReader();await reader.read();client.emit('notification',{channel:'test',payload:JSON.stringify({type:'dispatch_status_updated'})});client.emit('notification',{channel:'test',payload:JSON.stringify({type:'inbound_message',body:'secret'})});const event=new TextDecoder().decode((await reader.read()).value);assert.ok(event.includes('conversation-update'));assert.ok(!event.includes('secret'));assert.equal(client.listenerCount('notification'),1);abort.abort();assert.equal((await reader.read()).done,true,'No status notification queued');
console.log('PASS: 6 MB attachment reduced to lightweight URL; unchanged records preserved; authenticated access, deleted/foreign conversations, 304, ranges, streaming and status-event filtering.');
