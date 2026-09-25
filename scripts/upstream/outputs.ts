import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { buildCatalog } from './build-catalog.ts'

type GeneratedOutputs = Awaited<ReturnType<typeof buildCatalog>>

export async function writeOutputs(root: string, shouldFetch: boolean, outputs: GeneratedOutputs) {
  await writeFile(resolve(root, 'charts/krab/Chart.yaml'), outputs.updatedChart)
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
