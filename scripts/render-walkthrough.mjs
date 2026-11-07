// Render frames captured by record-terminal.py into self-hosted, captioned WebM videos.
// Usage: node scripts/render-walkthrough.mjs INPUT.json NAME OUTPUT_DIR MANIFEST.json
// Requires Chrome locally; no video encoder dependency or external service.
import { spawn } from 'node:child_process'
import { withWebmDuration } from './webm-duration.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
const [input, name, output, manifestPath] = process.argv.slice(2)
if (!manifestPath) throw Error('Expected INPUT.json NAME OUTPUT_DIR MANIFEST.json')
const recording = JSON.parse(await readFile(input, 'utf8'))
const pause = ms => new Promise(r => setTimeout(r, ms))
const chromePath = process.env.KRAB_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const chrome = spawn(chromePath, ['--headless', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=9226', `--user-data-dir=${join(tmpdir(),'krab-video-browser')}`, 'about:blank'], { stdio: 'ignore' })
let ws
try {
  let info
  for (let i=0; i<100; i++) {
    try { info=await (await fetch('http://127.0.0.1:9226/json/version')).json(); break }
    catch { await pause(100) }
  }
  if (!info) throw Error('Chrome debugging unavailable')
  ws = new WebSocket(info.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  let id=0
  const pending=new Map()
  ws.addEventListener('message', event => {
    const m=JSON.parse(event.data)
    if (m.id) {
      const p=pending.get(m.id); pending.delete(m.id)
      if(m.error) p.reject(Error(JSON.stringify(m.error))); else p.resolve(m.result)
    }
  })
  const call=(method, params={}, sessionId)=>new Promise((resolve,reject)=>{
    const n=++id; pending.set(n,{resolve,reject}); ws.send(JSON.stringify({id:n,method,params,sessionId}))
  })
  const target=await call('Target.createTarget',{url:'about:blank'})
  const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true})
  const page=(method,params)=>call(method,params,sessionId)
  await page('Emulation.setDeviceMetricsOverride',{width:1440,height:920,deviceScaleFactor:1,mobile:false})
  await page('Page.enable')
  const {frameTree}=await page('Page.getFrameTree')
  await page('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<style>body{margin:0;background:#0b1220}canvas{display:block}</style><canvas width="1440" height="920"></canvas>'})
  const result=await page('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async () => {
    const recording=${JSON.stringify(recording)}
    const canvas=document.querySelector('canvas'), ctx=canvas.getContext('2d')
    const images=new Map()
    for(const frame of recording.frames)if(frame.image){const img=new Image();img.src='data:image/png;base64,'+frame.image;await img.decode();images.set(frame,img)}
    const draw=frame=>{
      ctx.fillStyle='#0b1220';ctx.fillRect(0,0,1440,920)
      ctx.font='600 16px Menlo, monospace';ctx.fillStyle='#f15b3e';ctx.fillText('KRAB',32,29)
      ctx.font='13px Menlo, monospace';ctx.fillStyle='#a8b3c2';ctx.fillText(recording.title+' · '+recording.version,96,29)
      if(frame.image)ctx.drawImage(images.get(frame),0,40,1440,800)
      else frame.cells.forEach((row,y)=>row.forEach(([ch,fg,bg,bold],x)=>{
        const w=1344/row.length,h=760/frame.cells.length,font=Math.min(22,w/0.6)
        ctx.fillStyle=bg;ctx.fillRect(48+x*w,52+y*h,w+0.1,h)
        if(ch!==' '){ctx.fillStyle=fg;ctx.font=(bold?'600 ':'')+font+'px Menlo, monospace';ctx.fillText(ch,48+x*w,52+y*h+font)}
      }))
      ctx.fillStyle='#2c3a4d';ctx.fillRect(32,840,1376,1)
      ctx.fillStyle='#e2e8f0';ctx.font='17px system-ui, sans-serif'
      const words=frame.caption.split(' ');let line='',y=873
      for(const word of words){const next=line+word+' ';if(ctx.measureText(next).width>1120){ctx.fillText(line,32,y);line=word+' ';y+=25}else line=next}
      ctx.fillText(line,32,y)
      if(frame.keys){ctx.font='600 15px Menlo, monospace';ctx.fillStyle='#ff8a70';ctx.textAlign='right';ctx.fillText(frame.keys,1408,873);ctx.textAlign='left'}
    }
    draw(recording.frames[0])
    window.__poster=canvas.toDataURL('image/png').split(',')[1]
    const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8'].find(m=>MediaRecorder.isTypeSupported(m))
    if(!mime)throw Error('No WebM encoder available')
    const stream=canvas.captureStream(12), recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:1000000})
    const chunks=[]
    const ended=new Promise(resolve=>recorder.onstop=resolve)
    recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)}
    recorder.start(1000)
    for(const frame of recording.frames){draw(frame);await new Promise(r=>setTimeout(r,frame.seconds*1000))}
    recorder.stop();await ended;stream.getTracks().forEach(t=>t.stop())
    const blob=new Blob(chunks,{type:mime})
    return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(blob)})
  })()`})
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  await mkdir(output,{recursive:true})
  await writeFile(join(output,`${name}.webm`),withWebmDuration(Buffer.from(result.result.value,'base64'),recording.frames.reduce((s,f)=>s+f.seconds,0)))
  const poster=await page('Runtime.evaluate',{expression:'window.__poster',returnByValue:true})
  await writeFile(join(output,`${name}.png`),Buffer.from(poster.result.value,'base64'))
  const stamp=s=>`${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}.000`
  let seconds=0
  let vtt='WEBVTT\n\n'
  for(const frame of recording.frames){vtt+=`${stamp(seconds)} --> ${stamp(seconds+frame.seconds)}\n${frame.caption}${frame.keys?' ['+frame.keys+']':''}\n\n`;seconds+=frame.seconds}
  await writeFile(join(output,`${name}.vtt`),vtt)
  let manifest={}
  try { manifest=JSON.parse(await readFile(manifestPath,'utf8')) } catch {}
  manifest[name]={title:recording.title,version:recording.version,duration:seconds,
    steps:recording.frames.map(({caption,keys})=>({caption,keys}))}
  await mkdir(resolve(manifestPath,'..'),{recursive:true})
  await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n')
  console.log(`Rendered ${name}: ${seconds}s, ${Buffer.from(result.result.value,'base64').length} bytes`)
} finally { ws?.close(); chrome.kill() }
