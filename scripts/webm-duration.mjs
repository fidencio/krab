// MediaRecorder leaves the Segment size open and omits Duration. Add the Info
// duration so native browser controls can seek without downloading to the end.
export function withWebmDuration(buffer, seconds) {
  function element(offset) {
    const length = start => {
      let n = 1, bit = 0x80
      while (n <= 8 && !(buffer[start] & bit)) { n++; bit >>= 1 }
      if (n > 8 || start + n > buffer.length) throw Error('Invalid EBML header')
      return n
    }
    const idLength = length(offset)
    const id = buffer.subarray(offset, offset + idLength).toString('hex')
    const sizeOffset = offset + idLength
    const sizeLength = length(sizeOffset)
    let size = BigInt(buffer[sizeOffset] & (0xff >> sizeLength))
    for (let i=1;i<sizeLength;i++) size = (size << 8n) | BigInt(buffer[sizeOffset+i])
    const unknown = size === (1n << BigInt(7*sizeLength)) - 1n
    const start = sizeOffset + sizeLength
    return { offset, id, idLength, sizeLength, start, size: unknown ? null : Number(size),
      end: unknown ? buffer.length : start + Number(size) }
  }
  const vint = number => {
    const value = BigInt(number)
    let n=1
    while (value >= (1n << BigInt(7*n))-1n) n++
    const bytes=Buffer.alloc(n)
    let encoded=value | (1n << BigInt(7*n))
    for(let i=n-1;i>=0;i--) { bytes[i]=Number(encoded & 255n); encoded >>= 8n }
    return bytes
  }
  let segment
  for(let offset=0;offset<buffer.length;) {
    const el=element(offset)
    if(el.id==='18538067') { segment=el; break }
    offset=el.end
  }
  if(!segment)throw Error('WebM Segment missing')
  let info
  for(let offset=segment.start;offset<segment.end;) {
    const el=element(offset)
    if(el.id==='1549a966'){info=el;break}
    offset=el.end
  }
  if(!info)throw Error('WebM Info missing')
  let scale=1000000, duration
  for(let offset=info.start;offset<info.end;) {
    const el=element(offset)
    if(el.id==='2ad7b1')scale=Number(BigInt('0x'+buffer.subarray(el.start,el.end).toString('hex')))
    if(el.id==='4489')duration=el
    offset=el.end
  }
  const value=seconds*1e9/scale
  if(duration) {
    const fixed=Buffer.from(buffer)
    if(duration.size===8)fixed.writeDoubleBE(value,duration.start)
    else if(duration.size===4)fixed.writeFloatBE(value,duration.start)
    else throw Error('Invalid WebM duration size')
    return fixed
  }
  const data=Buffer.alloc(11)
  data.set([0x44,0x89,0x88]);data.writeDoubleBE(value,3)
  const infoData=Buffer.concat([buffer.subarray(info.start,info.end),data])
  const infoHeader=Buffer.concat([buffer.subarray(info.offset,info.offset+info.idLength),vint(infoData.length)])
  const body=Buffer.concat([buffer.subarray(segment.start,info.offset),infoHeader,infoData,buffer.subarray(info.end)])
  const segmentSize=segment.size===null ? buffer.subarray(segment.offset+segment.idLength,segment.start) : vint(body.length)
  return Buffer.concat([buffer.subarray(0,segment.offset+segment.idLength),segmentSize,body])
}
