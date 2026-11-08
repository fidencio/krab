import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { readYaml, requireValue } from './sources.ts'

export async function loadInputs(root: string, cachePath: (id: string) => string) {
  const qgsChart = await readYaml(cachePath('qgs-chart'))
  const kataChart = await readYaml(cachePath('kata-chart'))
  const kataVersions = await readYaml(cachePath('kata-versions'))
  const nfdChart = await readYaml(cachePath('nfd-chart'))
  const nfdValues = await readYaml(cachePath('nfd-values'))
  const plannedArchitecture = await readYaml(resolve(root, 'upstream/architecture.yaml'))
  const krabChart = await readYaml(resolve(root, 'charts/krab/Chart.yaml'))
  const krabValues = await readYaml(resolve(root, 'charts/krab/values.yaml'))
  const krabSchema = JSON.parse(await readFile(resolve(root, 'charts/krab/values.schema.json'), 'utf8'))
  const kataValuesRaw = await readFile(cachePath('kata-values'), 'utf8')
  const kataValues = parse(kataValuesRaw)
  // Specialized shims live in complete example profiles as of Kata 4.3.
  // Import their shim blocks without replacing the base chart's global defaults.
  const kataShimSources: Record<string, string> = Object.fromEntries(
    Object.keys(kataValues.shims).map(id => [id, 'kata-values']),
  )
  for (const sourceId of ['kata-nvidia-cpu-profile', 'kata-tee-profile']) {
    const profile = await readYaml(cachePath(sourceId))
    for (const [id, config] of Object.entries(profile.shims)) {
      if (id === 'disableAll') continue
      kataValues.shims[id] = config
      kataShimSources[id] = sourceId
    }
  }
  const kataProfileRaw = await readFile(cachePath('kata-nvidia-profile'), 'utf8')
  const kataProfile = parse(kataProfileRaw)
  const provisionerChart = await readYaml(cachePath('provisioner-chart'))
  const provisionerValues = parse(await readFile(cachePath('provisioner-values'), 'utf8'), { uniqueKeys: false })
  const devicePluginChart = await readYaml(cachePath('device-plugin-chart'))
  const provisionerReadme = await readFile(cachePath('provisioner-profiles'), 'utf8')
  const pluginCode = await readFile(cachePath('device-plugin-code'), 'utf8')
  const pluginValues = await readYaml(cachePath('device-plugin-values'))
  const kataChartReference = requireValue(
    kataProfileRaw.match(/helm install \S+ (oci:\/\/\S+)/)?.[1],
    'Unable to derive the Kata chart OCI reference',
  )
  const provisionerNamespace = requireValue(
    provisionerReadme.match(/--namespace\s+(\S+)/)?.[1],
    'Unable to derive the provisioner namespace',
  )
  return {
    qgsChart, kataChart, kataVersions, nfdChart, nfdValues, plannedArchitecture,
    krabChart, krabValues, krabSchema, kataValuesRaw, kataValues, kataShimSources,
    kataProfileRaw, kataProfile, provisionerChart, provisionerValues,
    devicePluginChart, provisionerReadme, pluginCode, pluginValues,
    kataChartReference, provisionerNamespace,
  }
}
