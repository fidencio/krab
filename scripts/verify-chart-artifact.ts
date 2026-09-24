import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { groups, type Group } from './refresh-upstream.ts'

const run = promisify(execFile)
const argument = process.argv.find((item) => item.startsWith('--group='))?.slice(8) ??
  process.argv[process.argv.indexOf('--group') + 1]
if (!Object.hasOwn(groups, argument)) throw new Error('Pass --group kata|nfd|device-plugin|provisioner')
const group = argument as Group
const expectedName = groups[group].chart
const chart = parse(await readFile(resolve(import.meta.dirname, '../charts/krab/Chart.yaml'), 'utf8')) as {
  dependencies: Array<{ name: string; version: string; repository: string }>
}
const dependency = chart.dependencies.find((item) => item.name === expectedName)
if (!dependency) throw new Error(`KRAB chart has no ${expectedName} dependency`)
const reference = `${dependency.repository}/${dependency.name}`
const output = await run('helm', ['show', 'chart', reference, '--version', String(dependency.version)])
const published = parse(output.stdout) as { name?: string; version?: string }
if (published.name !== expectedName || String(published.version) !== String(dependency.version)) {
  throw new Error(`${reference} published metadata differs from the generated dependency`)
}
console.log(`Verified ${reference}:${dependency.version}`)
