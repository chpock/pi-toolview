// One engine per fresh process. No timing with diagnostic scopes enabled.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import { createEngine, serialize, assertText } from './engine.mjs';
import { languages, samples, source, realSource, streamSource, appendChunks } from './corpus.mjs';
const kind=process.argv[2], scenario=process.argv[3] ?? 'check';
const snapshot=()=>{global.gc?.();global.gc?.();return {...process.memoryUsage(),maxRSS:process.resourceUsage().maxRSS*1024};};
const baseline=snapshot();const engine=await createEngine(kind,scenario==='check'?Object.keys(samples):languages);
const initialized=snapshot();
const result={harnessVersion:2,kind,scenario,node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0].model,initializationMs:engine.initializationMs,loadedLanguages:engine.loadedLanguages,baseline,initialized};
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const timed=(fn,n=9)=>{const xs=[];let result;for(let i=0;i<n;i++){const t=performance.now();result=fn();xs.push(performance.now()-t);}return {firstMs:xs[0],medianMs:median(xs.slice(1)),p95Ms:[...xs.slice(1)].sort((a,b)=>a-b)[Math.ceil((n-1)*.95)-1],result};};
const modes=kind.startsWith('tree')?['full','range']:['line-state'];
if(scenario==='check') {
  result.quality=[];result.equality=[];
  for(const [lang,text]of Object.entries(samples)) {
    const spans=engine.full(text,lang);assertText(text,spans);
    result.quality.push({lang,text,spans,raw:engine.raw?.(text,lang)});
    const chunks=appendChunks(text);for(const mode of modes){const session=engine.session(lang,mode);let next='';for(const chunk of chunks){next+=chunk;const got=session.update(next);assertText(next,got);assert.deepEqual(got,engine.full(next,lang),`${kind} ${lang} ${mode} append ${next.length}`);}session.dispose();result.equality.push({lang,mode,updates:chunks.length,exact:true});}
  }
  for(const [name,text]of Object.entries(streamSource)) {
    const lang=name.startsWith('typescript')?'typescript':name;
    for(const mode of modes){const session=engine.session(lang,mode);let next='';let updates=0;for(const chunk of appendChunks(text)){next+=chunk;const got=session.update(next);assert.deepEqual(got,engine.full(next,lang),`${kind} ${name} ${mode} large append ${next.length}`);updates++;}session.dispose();result.equality.push({name,mode,updates,exact:true});}
  }
  for(const lang of languages)for(const mode of modes){
    const text=source(lang,80);const session=engine.session(lang,mode);session.update(text);
    const revisions=[text.replace('result0','REPLACED'),text.replace('name','another'),text.replace(/\n/,'\n/*'),text];
    for(const next of revisions){const got=session.update(next);assertText(next,got);assert.deepEqual(got,engine.full(next,lang),`${kind} ${lang} ${mode} middle`);}session.dispose();result.equality.push({lang,mode,middle:revisions.length,exact:true});
  }
  result.noop=[];
  for(const lang of languages)for(const mode of modes){const text=source(lang,25),session=engine.session(lang,mode);session.update(text);engine.resetCounters();for(let i=0;i<10;i++)session.update(text);assert.deepEqual(engine.counters,{parses:0,queries:0,tokenizedLines:0,queryReturnedCaptures:0});session.dispose();result.noop.push({lang,mode,counters:{...engine.counters}});}
} else if(scenario==='bench') {
  result.full=[];
  for(const lang of languages)for(const lines of [25,1000]){
    const text=source(lang,lines);const got=engine.full(text,lang);assertText(text,got);
    engine.resetCounters();const t=timed(()=>engine.full(text,lang));const a=timed(()=>serialize(text,engine.full(text,lang)));
    result.full.push({lang,lines,units:text.length,hash:createHash('sha256').update(text).digest('hex'),tokens:t.result.length,spans:{firstMs:t.firstMs,medianMs:t.medianMs,p95Ms:t.p95Ms},ansi:{firstMs:a.firstMs,medianMs:a.medianMs,p95Ms:a.p95Ms},counters:{...engine.counters}});
  }
  const r=timed(()=>serialize(realSource,engine.full(realSource,'typescript')));result.real={units:realSource.length,lines:realSource.split('\n').length,hash:createHash('sha256').update(realSource).digest('hex'),medianMs:r.medianMs,p95Ms:r.p95Ms};
  const long='const value = '+Array.from({length:1000},(_,i)=>`client.fetch(user.id${i})`).join(' + ')+';';const l=timed(()=>serialize(long,engine.full(long,'typescript')),5);result.longLine={units:long.length,medianMs:l.medianMs,p95Ms:l.p95Ms};
  result.stream=[];
  for(const [name,text]of Object.entries(streamSource))for(const mode of modes){
    const lang=name.startsWith('typescript')?'typescript':name;const runs=[];let counters;
    for(let trial=0;trial<4;trial++){
      const session=engine.session(lang,mode);let next='',elapsed=0;const times=[];engine.resetCounters();
      for(const chunk of appendChunks(text)){next+=chunk;const t=performance.now();serialize(next,session.update(next));const delta=performance.now()-t;elapsed+=delta;times.push(delta);}
      counters={...engine.counters};session.dispose();runs.push({elapsed,max:Math.max(...times),updates:times.length});
    }
    result.stream.push({name,mode,units:text.length,updates:runs[0].updates,totalMedianMs:median(runs.slice(1).map(r=>r.elapsed)),maxMedianMs:median(runs.slice(1).map(r=>r.max)),counters});
  }
  result.middle=[];
  for(const lang of languages)for(const mode of modes){const text=source(lang,1000);const session=engine.session(lang,mode);session.update(text);const edited=lang==='bash'?text.replace('500:$name','500:$USER'):text.replace('result500','rename500');assert.notEqual(edited,text);assert.equal(edited.length,text.length);const targets=[edited,text];engine.resetCounters();let i=0;const t=timed(()=>{const next=targets[i++%2];return serialize(next,session.update(next));});result.middle.push({lang,mode,medianMs:t.medianMs,p95Ms:t.p95Ms,counters:{...engine.counters}});session.dispose();}
} else if(scenario==='memory') {
  // Each phase runs with this engine only; counts and allocation sizes are equal.
  for(const lang of languages)engine.full(samples[lang],lang);
  result.afterWarm=snapshot();
  let smallSessions=Array.from({length:20},(_,i)=>{const lang=languages[i%languages.length],s=engine.session(lang,'full');s.update(source(lang,1000));return s;});
  result.activeBeforeLarge=snapshot();for(const s of smallSessions)s.dispose();smallSessions=undefined;result.releasedBeforeLarge=snapshot();
  for(const lang of languages){const text=source(lang,10000);let spans=engine.full(text,lang);let ansi=serialize(text,spans);spans=undefined;ansi=undefined;}
  result.afterLarge=snapshot();
  let sessions=Array.from({length:20},(_,i)=>{const lang=languages[i%languages.length],s=engine.session(lang,'full');s.update(source(lang,1000));return s;});
  result.twentyActive=snapshot();for(const s of sessions)s.dispose();sessions=undefined;
  result.releasedSessions=snapshot();engine.dispose();result.disposed=snapshot();
} else if(scenario==='profile') {
  const lines=Number(process.argv[4] ?? 1000);const lang=process.argv[5] ?? 'typescript';const text=source(lang,lines);result.units=text.length;result.lang=lang;result.lines=lines;result.phases=[{phase:'input',...snapshot()}];
  engine.profile(text,lang,phase=>result.phases.push({phase,...snapshot()}));
} else throw new Error('Unknown scenario');
result.final=snapshot();console.log(JSON.stringify(result));
