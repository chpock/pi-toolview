// Observed category mapping under one generic theme, not a universal quality score.
import{readFileSync,writeFileSync}from'node:fs';
import{dirname,resolve}from'node:path';
import{fileURLToPath}from'node:url';
const dir=dirname(fileURLToPath(import.meta.url));const results={};
for(const kind of ['tree','syntect','giallo','shiki']){const input=JSON.parse(readFileSync(resolve(dir,`check-${kind}.json`),'utf8'));results[kind]={};for(const check of input.checks){const words={};for(const word of ['const','let','result','User','client','fetch','user','id','fallback','greet','name','return']){const match=new RegExp(`\\b${word}\\b`).exec(check.text);if(!match)continue;const start=kind==='shiki'?match.index:Buffer.byteLength(check.text.slice(0,match.index));const end=start+Buffer.byteLength(word);const categories=[...new Set(check.spans.filter(([a,b])=>a<end&&b>start).map(([, ,role])=>typeof role==='string'?role:check.roles[role]))];words[word]=categories;}results[kind][check.lang]=words;}}
writeFileSync(resolve(dir,'quality.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
