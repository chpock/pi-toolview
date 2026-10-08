import assert from'node:assert/strict';
import{createHash}from'node:crypto';
import{performance}from'node:perf_hooks';
import{createEngine,serialize}from'../head-to-head/engine.mjs';
import{languages,samples,source,realSource,streamSource,appendChunks}from'../head-to-head/corpus.mjs';
import{connect,strip}from'./rpc.mjs';
const mode=process.argv[2],socketPath=process.argv[3],number=Number(process.argv[4]);
const cases=[...languages.flatMap(lang=>[25,1000].map(n=>({name:`${lang}-${n}`,lang,source:source(lang,n)}))),{name:'real-typescript',lang:'typescript',source:realSource}];
const stress=languages.map(lang=>({lang,source:source(lang,10000)}));
const unique=(text,lang)=>text+`\n${lang==='python'||lang==='bash'?'#':'//'} research-client-${number}`;
const snapshot=()=>{global.gc?.();global.gc?.();return {...process.memoryUsage(),retainedAnsiBytes:retained.reduce((n,s)=>n+Buffer.byteLength(s),0)};};
let engine,rpc,retained=[],calls=0;
async function highlight(text,lang){calls++;let result;if(mode==='inprocess'){const at=performance.now();const ansi=serialize(text,engine.full(text,lang));result={ok:true,ansi,computeNs:Math.round((performance.now()-at)*1e6)};}else result=await rpc.call({op:'highlight',lang,source:text});assert.ok(result.ok,JSON.stringify(result));return result;}
async function phase(command){
 if(command==='init'){const at=performance.now();if(mode==='inprocess')engine=await createEngine('shiki-onig',languages);else rpc=await connect(socketPath);for(const lang of languages){const r=await highlight(unique(samples[lang],lang),lang);assert.equal(strip(r.ansi),unique(samples[lang],lang));retained.push(r.ansi);}return{initializationMs:performance.now()-at,heap:snapshot(),calls};}
 if(command==='bench'){const rows=[];for(const c of cases){const text=unique(c.source,c.lang),times=[],compute=[],outputBytes=[];for(let i=0;i<5;i++){const at=performance.now();const r=await highlight(text,c.lang);times.push(performance.now()-at);compute.push(r.computeNs/1e6);assert.equal(strip(r.ansi),text);outputBytes.push(Buffer.byteLength(r.ansi));retained=[r.ansi];}rows.push({name:c.name,inputBytes:Buffer.byteLength(text),sourceHash:createHash('sha256').update(text).digest('hex'),timesMs:times.slice(1),computeMs:compute.slice(1),outputBytes:outputBytes.at(-1)});}return{rows,calls,heap:snapshot(),wire:rpc?{...rpc.counts}:null};}
 if(command==='stream'){const rows=[];for(const name of ['bash','typescript-function']){const lang=name==='bash'?'bash':'typescript';const text=streamSource[name];let next='',times=[],compute=[];for(const chunk of appendChunks(text)){next+=chunk;const at=performance.now();const r=await highlight(next,lang);times.push(performance.now()-at);compute.push(r.computeNs/1e6);assert.equal(strip(r.ansi),next);}rows.push({name,updates:times.length,timesMs:times,computeMs:compute});}return{rows,calls,heap:snapshot()};}
 if(command==='stress'){for(const c of stress){const text=unique(c.source,c.lang);const r=await highlight(text,c.lang);assert.equal(strip(r.ansi),text);retained=[r.ansi];}return{calls,heap:snapshot()};}
 if(command==='release'){retained=[];engine?.dispose();rpc?.close();return{calls,heap:snapshot()};}
 throw new Error('unknown command');
}
process.on('message',async message=>{try{const value=await phase(message.command);process.send({command:message.command,ok:true,value});}catch(error){process.send({command:message.command,ok:false,error:String(error.stack)});}});
process.send({ready:true,pid:process.pid,node:process.version,baseline:snapshot()});
