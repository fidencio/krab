import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { readYaml, requireValue } from './sources.ts'

export async function loadInputs(root: string, cachePath: (id: string) => string) {
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
    kataChart, kataVersions, nfdChart, nfdValues, plannedArchitecture,
    krabChart, krabValues, krabSchema, kataValuesRaw, kataValues,
    kataProfileRaw, kataProfile, provisionerChart, provisionerValues,
    devicePluginChart, provisionerReadme, pluginCode, pluginValues,
    kataChartReference, provisionerNamespace,
  }
}
