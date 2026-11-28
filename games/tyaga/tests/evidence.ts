import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHYSICS_BUILD_HASH } from '../src/server-world/world';
function sourceFiles(directory:string):string[]{return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sourceFiles(join(directory,entry.name)):[join(directory,entry.name)]).filter(p=>p.endsWith('.ts'));}
export function evidence(name:string,measurements:unknown,kind='isolated physical test fixture; not browser acceptance'):void{
 const destination=process.env.TYAGA_PHYSICS_EVIDENCE;if(!destination)return;
 const roots=['core','maps','server-world','bots','tutorial'].map(name=>`games/tyaga/src/${name}`);const hash=createHash('sha256');
 for(const file of roots.flatMap(sourceFiles).sort()){hash.update(file);hash.update(readFileSync(file));}
 mkdirSync(destination,{recursive:true});writeFileSync(join(destination,`${name}.json`),JSON.stringify({scenario:name,kind,physicsBuildHash:PHYSICS_BUILD_HASH,sourceHash:hash.digest('hex'),measuredAt:new Date().toISOString(),measurements},null,2)+'\n');
}
