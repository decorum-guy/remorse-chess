import { cpSync, createReadStream, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
const assetDirectory=fileURLToPath(new URL('../../games/test-bench/public/test-bench/',import.meta.url));
const mime:Record<string,string>={'.glb':'model/gltf-binary','.wav':'audio/wav','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2','.css':'text/css','.json':'application/json'};
export function testBenchAssets():Plugin {
  let output='';
  return {name:'test-bench-assets',configResolved(config){output=resolve(config.root,config.build.outDir,'test-bench');},
    closeBundle(){if(existsSync(assetDirectory))cpSync(assetDirectory,output,{recursive:true});},
    configureServer(server){server.middlewares.use('/test-bench',(req,res,next)=>{
      let relative:string;try{relative=decodeURIComponent((req.url??'').split('?')[0]);}catch{res.statusCode=400;res.end();return;}
      const target=resolve(assetDirectory,'.'+relative);
      if(!target.startsWith(assetDirectory)||!existsSync(target)||!mime[extname(target)]){next();return;}
      res.setHeader('Content-Type',mime[extname(target)]);res.setHeader('Cache-Control','no-cache');createReadStream(target).on('error',()=>{res.statusCode=404;res.end();}).pipe(res);
    });},
  };
}
