import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import type { buildCatalog } from './build-catalog.ts'

type GeneratedOutputs = Awaited<ReturnType<typeof buildCatalog>>

export async function writeOutputs(root: string, shouldFetch: boolean, outputs: GeneratedOutputs) {
  await writeFile(resolve(root, 'charts/krab/Chart.yaml'), outputs.updatedChart)
  const chart = parse(outputs.updatedChart) as {
    dependencies?: { name: string; version: string; repository: string; condition?: string }[]
  }
  const rows = (chart.dependencies ?? []).map(({ name, version, repository, condition }) =>
    `| ${name} | ${version} | \`${repository}\` | ${condition ? `\`${condition}\`` : 'Always'} |`)
  const start = '<!-- chart-dependencies:start -->'
  const end = '<!-- chart-dependencies:end -->'
  const readmePath = resolve(root, 'README.md')
  const readme = await readFile(readmePath, 'utf8')
  if (readme.split(start).length !== 2 || readme.split(end).length !== 2) {
    throw new Error('README.md must contain one chart dependency table')
  }
  const table = [
    '| Chart | Version | OCI repository | Enabled when |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
  const nextReadme = readme.replace(new RegExp(`${start}[\\s\\S]*?${end}`),
    `${start}\n\n${table}\n\n${end}`)
  if (nextReadme !== readme) await writeFile(readmePath, nextReadme)
  await writeFile(resolve(root, 'charts/krab/values.yaml'), outputs.updatedValues)
  await writeFile(resolve(root, 'Dockerfile.precheck'), outputs.updatedPrecheck.dockerfile)
  await writeFile(resolve(root, 'charts/precheck/values.yaml'), outputs.updatedPrecheck.values)
  if (shouldFetch) {
    await writeFile(resolve(root, 'upstream/precheck-image.lock.json'),
      `${JSON.stringify(outputs.precheckImageLock, null, 2)}\n`)
  }
  const generatedRoot = resolve(root, 'src/generated')
  await mkdir(generatedRoot, { recursive: true })
  await writeFile(resolve(generatedRoot, 'catalog.json'), `${JSON.stringify(outputs.catalog, null, 2)}\n`)
  await writeFile(resolve(generatedRoot, 'provenance.json'), `${JSON.stringify(outputs.provenance, null, 2)}\n`)
  const summary = [
    `${outputs.familyCount} hardware families`,
    `${outputs.runtimeClassCount} NVIDIA runtime-rs classes`,
    `${outputs.localShimCount} local RuntimeClasses`,
    `${outputs.provenance.generatedFrom.length} provenance records`,
  ].join(', ')
  console.log(`Generated ${summary}.`)
}
