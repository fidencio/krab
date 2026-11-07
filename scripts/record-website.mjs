// Capture the actual local builder for the website navigation walkthrough.
// Usage: node scripts/record-website.mjs OUTPUT.json
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const version=JSON.parse(await readFile('package.json','utf8')).version
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5173'],{stdio:'ignore'})
const chrome=spawn(process.env.KRAB_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless','--disable-gpu','--no-first-run','--hide-scrollbars','--remote-debugging-port=9227',`--user-data-dir=${join(tmpdir(),'krab-site-recording')}`,'about:blank'],{stdio:'ignore'})
let ws
try {
  let info
  for(let i=0;i<100;i++){try{info=await(await fetch('http://127.0.0.1:9227/json/version')).json();break}catch{await pause(100)}}
  if(!info)throw Error('Chrome debugging unavailable')
  ws=new WebSocket(info.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}))
  let id=0;const pending=new Map()
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(Error(JSON.stringify(m.error)));else p.resolve(m.result)}})
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params,sessionId}))})
  const target=await call('Target.createTarget',{url:'about:blank'})
  const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true})
  const page=(method,params)=>call(method,params,sessionId)
  const action=async expression=>{const r=await page('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));await pause(300)}
  await page('Emulation.setDeviceMetricsOverride',{width:1440,height:800,deviceScaleFactor:1,mobile:false})
  await page('Page.enable');await page('Page.navigate',{url:'http://127.0.0.1:5173/'})
  await pause(1400)
  const frames=[]
  const capture=async(caption,keys,seconds=4)=>{const shot=await page('Page.captureScreenshot',{format:'png'});frames.push({caption,keys,seconds,image:shot.data})}
  await capture('Start with the builder. The header gives you documentation, theme, and release choices.','')
  await action(`document.querySelector('.platform-directory').scrollIntoView({behavior:'instant'})`)
  await capture('Choose Custom to combine runtime and hardware paths, or start with a vendor path.','Choose a deployment path')
  await action(`document.querySelector('.platform-row').click()`)
  await capture('The configuration page starts with target architectures and the Kubernetes distribution.','Custom')
  await action(`document.querySelector('.custom-architecture-options input').click();document.querySelector('.distribution-select-trigger').click()`)
  await action(`[...document.querySelectorAll('.distribution-select-options button')].find(b=>b.textContent.toLowerCase().includes('kubeadm')).click()`)
  await action(`const label=[...document.querySelectorAll('.local-runtime-grid label')].find(l=>l.querySelector('strong')?.textContent==='QEMU');if(!label)throw Error('Base QEMU runtime missing');label.querySelector('input').click();label.scrollIntoView({behavior:'instant',block:'center'})`)
  await capture('Select the runtime you want to install. KRAB checks the architecture coverage as you choose.','AMD64 · kubeadm · QEMU')
  await action(`document.querySelector('.deploy-section').scrollIntoView({behavior:'instant'})`)
  await capture('Review the version-pinned Helm command and generated values before deploying.','Review the output')
  await action(`URL.createObjectURL=blob=>{window.__exported=blob.text();return 'blob:recording'};document.addEventListener('click',e=>{if(e.target.closest('a[download]'))e.preventDefault()});const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Continue in TUI / CLI'));if(!button)throw Error('Native export unavailable');button.scrollIntoView({behavior:'instant',block:'center'});button.click()`)
  const config=await page('Runtime.evaluate',{expression:'window.__exported',awaitPromise:true,returnByValue:true})
  if(JSON.parse(config.result.value).distribution!=='kubeadm')throw Error('Export lost distribution')
  await capture('Download values for Helm, or export krab.json to keep working in the TUI and CLI.','Continue in TUI / CLI')
  await writeFile(process.argv[2],JSON.stringify({title:'Navigate the website builder',version:`KRAB ${version}`,frames}))
  console.log(`Captured ${frames.length} real website frames`)
} finally {ws?.close();chrome.kill();server.kill()}
