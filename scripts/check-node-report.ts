import { parseNodePrecheck } from '../src/lib/precheck.ts'

let input = ''
for await (const chunk of process.stdin) input += chunk
const report = parseNodePrecheck(input)
console.log(`Valid ${report.node.architecture} node report`)
