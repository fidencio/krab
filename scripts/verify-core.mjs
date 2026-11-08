import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
function rustFiles(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()
    ? rustFiles(resolve(directory,entry.name)) : entry.name.endsWith('.rs') ? [resolve(directory,entry.name)] : [])
}
try {
  const files=[...rustFiles(resolve(root,'core/src')),...['core/Cargo.toml','core/Cargo.lock',
    'scripts/build-core.py','src/generated/catalog.json','charts/krab/values.schema.json',
    'upstream/erofs-utils-image.lock.json'].map(p=>resolve(root,p))].sort()
  const digest=createHash('sha256')
  for(const path of files) digest.update(relative(root,path).split('\\').join('/')+'\0').update(readFileSync(path))
  const metadata=JSON.parse(readFileSync(resolve(root,'src/generated/core-build.json'),'utf8'))
  const wasm=readFileSync(resolve(root,'src/generated/engine/engine_bg.wasm'))
  const version=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).version
  if(metadata.sourceSha256!==digest.digest('hex')||metadata.wasmSha256!==createHash('sha256').update(wasm).digest('hex')||metadata.version!==version||metadata.bindingsSha256!==createHash('sha256').update(readFileSync(resolve(root,'src/generated/engine/engine.js'))).digest('hex')) {
    throw Error('Shared engine is stale')
  }
} catch(error) {
  console.error(`${error.message}. Build the shared engine with npm run build:core (Rust 1.95.0 and wasm32-unknown-unknown required).`)
  process.exitCode=1
}
