import assert from'node:assert/strict';
import{readFileSync,writeFileSync,existsSync}from'node:fs';
import{createHash}from'node:crypto';
import{resolve,dirname}from'node:path';
const dir=dirname(new URL(import.meta.url).pathname),rows=readFileSync(resolve(dir,'results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows.length,48);
const kinds=['tree-native','tree-wasm','shiki-js','shiki-onig'];
const sourceHash=createHash('sha256').update(readFileSync(resolve(dir,'file-card-snapshot.txt'))).digest('hex');
const proof={node:'v22.19.0',harnessVersion:2,records:rows.length,sourceHash,engines:{}};
for(const kind of kinds){
 const b=rows.filter(r=>r.kind===kind&&r.scenario==='bench'),m=rows.filter(r=>r.kind===kind&&r.scenario==='memory'),p=rows.filter(r=>r.kind===kind&&r.scenario==='profile');
 assert.equal(b.length,5);assert.equal(m.length,3);assert.equal(p.length,4);
 for(const r of [...b,...m,...p]){assert.equal(r.node,'v22.19.0');assert.equal(r.harnessVersion,2);}
 for(const r of b){assert.equal(r.real.hash,sourceHash);assert.equal(r.real.units,20001);assert.equal(r.real.lines,363);}
 const c=JSON.parse(readFileSync(resolve(dir,`check-${kind}.json`),'utf8'));assert.equal(c.quality.length,9);assert.ok(c.equality.every(e=>e.exact));assert.ok(c.noop.every(e=>Object.values(e.counters).every(n=>n===0)));
 proof.engines[kind]={timingProcesses:b.length,memoryProcesses:m.length,phaseProcesses:p.length,qualitySamples:c.quality.length,equalityCases:c.equality.length,equalityUpdates:c.equality.reduce((sum,e)=>sum+(e.updates??e.middle??0),0),zeroWorkCases:c.noop.length};
}
for(const [a,b]of[['tree-native','tree-wasm'],['shiki-js','shiki-onig']]){
 const qa=JSON.parse(readFileSync(resolve(dir,`check-${a}.json`),'utf8')).quality,qb=JSON.parse(readFileSync(resolve(dir,`check-${b}.json`),'utf8')).quality;
 assert.deepEqual(qa.map(q=>q.spans),qb.map(q=>q.spans));
}
const reportRoot=resolve(dir,'../..');let links=0;
for(const name of ['README.md','tree-sitter-vs-shiki.md','head-to-head-coverage.md','head-to-head-review.md']){
 const text=readFileSync(resolve(reportRoot,name),'utf8');
 for(const [,link]of text.matchAll(/\]\(([^)]+)\)/g))if(!/^https?:|^#/.test(link)){assert.ok(existsSync(resolve(reportRoot,link.split('#')[0])),`${name}: missing ${link}`);links++;}
}
proof.localLinks=links;proof.withinFamilyRoleEquality=true;proof.productionTestsRun=false;proof.candidateReplayRun=false;
writeFileSync(resolve(dir,'validation.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
