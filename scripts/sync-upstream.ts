import { resolve } from 'node:path'
import process from 'node:process'
import { syncReleaseVersion } from './sync-release-version.ts'
import { loadSources } from './upstream/sources.ts'
import { loadPolicies } from './upstream/policy.ts'
import { loadInputs } from './upstream/inputs.ts'
import { buildCatalog } from './upstream/build-catalog.ts'
import { writeOutputs } from './upstream/outputs.ts'

async function main() {
  const root = resolve(import.meta.dirname, '..')
  const shouldFetch = process.argv.includes('--fetch')
  const sources = await loadSources(root, shouldFetch)
  const policies = await loadPolicies(root)
  const release = await syncReleaseVersion(root)
  const inputs = await loadInputs(root, sources.cachePath)
  const outputs = await buildCatalog({ root, shouldFetch, sources, policies, inputs, release })
  await writeOutputs(root, shouldFetch, outputs)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
