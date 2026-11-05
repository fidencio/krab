import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parseAllDocuments } from 'yaml'
import { generate, prepare } from './fixtures/nvidia-cpu-cc.ts'

test('CPU CC values render through the pinned, unmodified Kata chart', (t) => {
  const directory = prepare(t)
  const result = generate(directory)
  assert.equal(result.status, 0, result.stderr)
  const overlay = JSON.parse(result.stdout)['kata-deploy']
  const file = join(directory, 'values.json')
  writeFileSync(file, JSON.stringify({ ...overlay,
    image: { reference: 'quay.io/kata-containers/kata-deploy', tag: '4.3.1' },
    shims: { disableAll: true, ...overlay.shims },
    snapshotter: { setup: ['nydus'] },
    nodeFeatureRules: { create: true },
    'node-feature-discovery': { enabled: false },
  }))
  const chart = resolve('charts/krab/charts/kata-deploy-4.3.1.tgz')
  const rendered = execFileSync('helm', ['template', 'cpu-cc', chart, '-f', file], { encoding: 'utf8' })
  const manifests = parseAllDocuments(rendered).map(doc => doc.toJS()).filter(Boolean)
  const classes = manifests.filter(doc => doc.kind === 'RuntimeClass')
  assert.deepEqual(classes.map(doc => doc.metadata.name).sort(), [
    'kata-qemu-nvidia-cpu-snp-runtime-rs', 'kata-qemu-nvidia-cpu-tdx-runtime-rs',
  ])
  for (const runtime of classes) {
    assert.equal(runtime.overhead.podFixed.memory, '10240Mi')
    assert.equal(runtime.scheduling.nodeSelector['kata-deploy.katacontainers.io/default'], 'true')
    assert.equal(runtime.scheduling.nodeSelector['nvidia.com/cc.ready.state'], undefined)
  }
  const configs = manifests.find(doc => doc.kind === 'ConfigMap' && doc.data?.['custom-runtimes.list'])
  assert.ok(configs)
  for (const tee of ['snp', 'tdx']) {
    const name = `qemu-nvidia-cpu-${tee}-runtime-rs`
    const base = `qemu-nvidia-gpu-${tee}-runtime-rs`
    assert.ok(configs.data['custom-runtimes.list'].includes(`kata-${name}:${base}:nydus:guest-pull:amd64`))
    assert.equal(configs.data[`dropin-kata-${name}.toml`], overlay.customRuntimes.runtimes[name].dropIn)
  }
})
