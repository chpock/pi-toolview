import net from 'node:net';
import {once} from 'node:events';
export async function connect(path){
 const socket=net.createConnection(path);socket.setEncoding('utf8');await once(socket,'connect');
 let buffer='',id=0;const pending=new Map();const counts={sentBytes:0,receivedBytes:0,requests:0};
 const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
 socket.on('error',fail);socket.on('close',()=>fail(new Error('highlight socket closed')));
 socket.on('data',chunk=>{counts.receivedBytes+=Buffer.byteLength(chunk);buffer+=chunk;if(buffer.length>16*1024*1024){socket.destroy(new Error('oversize response'));return;}let at;while((at=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let response;try{response=JSON.parse(line);}catch(error){socket.destroy(error);return;}const p=pending.get(response.id);if(!p)continue;pending.delete(response.id);clearTimeout(p.timer);p.resolve(response);}});
 return {socket,counts,call(request){if(typeof request.source==='string'&&!request.source.isWellFormed())return Promise.reject(new Error('research protocol requires well-formed Unicode'));const sequence=++id;const text=JSON.stringify({...request,id:sequence})+'\n';counts.requests++;counts.sentBytes+=Buffer.byteLength(text);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(sequence);reject(new Error('highlight request timeout'));},30000);pending.set(sequence,{resolve,reject,timer});socket.write(text);});},close(){socket.end();}};
}
export const strip=ansi=>ansi.replace(/\x1b\[[\d;]*m/g,'');
