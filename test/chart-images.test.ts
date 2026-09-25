import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse, parseDocument } from 'yaml'
import { syncChartImages, type KrabImageDefaults } from '../scripts/sync-chart-images.ts'

const valuesPath = resolve(import.meta.dirname, '../charts/krab/values.yaml')

test('image sync updates pins without changing KRAB deployment policy', async () => {
  const original = await readFile(valuesPath, 'utf8')
  const values = parse(original)
  const images: KrabImageDefaults = {
    nfd: values['node-feature-discovery'].image,
    kataDeploy: values['kata-deploy'].image,
    kubectl: values['kata-deploy'].kubectlImage,
    kataDispatcher: values['kata-deploy'].job.dispatcherImage,
    devicePlugin: values['kata-device-plugin'].image,
    provisioner: values['kata-device-provisioner'].image,
    provisionerDispatcher: values['kata-device-provisioner'].job.dispatcherImage,
  }
  const staleDocument = parseDocument(original)
  staleDocument.setIn(['node-feature-discovery', 'image', 'tag'], 'old-nfd')
  staleDocument.setIn(['kata-device-provisioner', 'job', 'dispatcherImage', 'tag'], 'old-dispatcher')
  const stale = staleDocument.toString()

  const updated = syncChartImages(stale, images)
  assert.equal(updated, original)
  assert.equal(syncChartImages(updated, images), updated)
  assert.equal(parse(updated)['kata-deploy'].shims.disableAll, true)
  assert.equal(parse(updated).nvidia.enabled, false)
  assert.throws(
    () => syncChartImages(original.replace('  kubectlImage:', '  oldKubectlImage:'), images),
    /kata-deploy.kubectlImage must have reference and tag/,
  )
})
