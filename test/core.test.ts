import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { coreCatalog, coreDefaults, coreRequest, coreVersion } from '../src/lib/core.ts'
import catalog from '../src/generated/catalog.json' with { type: 'json' }
import pkg from '../package.json' with { type: 'json' }

const config = { apiVersion: 'krab/v1alpha1', vendor: 'custom', distribution: 'kubeadm',
  architectures: ['amd64'], runtimes: ['qemu-runtime-rs'] }

test('browser tool downloads recover through the release API and fail closed on invalid assets', () => {
  const result = spawnSync('python3', [resolve(import.meta.dirname, 'build-core-downloads.py')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('SBOM tool downloads require the pinned version and an intact regular executable', () => {
  const result = spawnSync('python3', [resolve(import.meta.dirname, 'syft-downloads.py')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('browser embeds the exact native catalog and version, and Rust validates its configuration', () => {
  assert.equal(coreVersion, pkg.version)
  assert.deepEqual(coreCatalog, catalog)
  assert.equal((coreDefaults as Record<string, unknown>).erofsSnapshotterMode, 'memory')
  const values = coreRequest<Record<string, any>>('generate', config)
  assert.equal(values['kata-deploy'].shims['qemu-runtime-rs'].enabled, true)
  assert.throws(() => coreRequest('validate', { ...config, unknownSetting: true }), /unknown field/)
  assert.throws(() => coreRequest('validate', { ...config, architectures: ['s390x'], runtimes: ['qemu-tdx-runtime-rs'] }), /architectures|supports/)
  assert.throws(() => coreRequest('schema', undefined, undefined, { unexpectedChart: true }), /Additional|not allowed|unexpectedChart/ )
  assert.throws(() => coreRequest('generate', { ...config, valuesOverrides: { 'kata-deploy': { enabled: 'invalid' } } }), /not of type.*boolean/)
  assert.throws(() => coreRequest('generate', { ...config, runtimes: [] }), /Select at least one runtime/)
})

test('stale Rust source or tampered Wasm cannot pass the website build guard', (t) => {
  const root = resolve(import.meta.dirname, '..')
  const directory = mkdtempSync(join(tmpdir(), 'krab-core-freshness-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const files = ['scripts/verify-core.mjs', 'scripts/build-core.py', 'core/Cargo.toml', 'core/Cargo.lock',
    'package.json', 'src/generated/catalog.json', 'src/generated/core-build.json', 'src/generated/engine/engine_bg.wasm', 'src/generated/engine/engine.js',
    'charts/krab/values.schema.json', 'upstream/erofs-utils-image.lock.json']
  for (const path of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    cpSync(join(root, path), join(directory, path))
  }
  cpSync(join(root, 'core/src'), join(directory, 'core/src'), { recursive: true })
  const check = () => spawnSync(process.execPath, [join(directory, 'scripts/verify-core.mjs')], { encoding: 'utf8' })
  assert.equal(check().status, 0)
  const source = join(directory, 'core/src/lib.rs')
  const original = readFileSync(source)
  writeFileSync(source, Buffer.concat([original, Buffer.from('\n// New engine behavior\n')]))
  assert.equal(check().status, 1)
  writeFileSync(source, original)
  const wasm = join(directory, 'src/generated/engine/engine_bg.wasm')
  const changed = readFileSync(wasm)
  changed[changed.length - 1] ^= 1
  writeFileSync(wasm, changed)
  assert.equal(check().status, 1)
})


test('shared YAML rendering preserves Helm YAML 1.1 strings and literal drop-ins', () => {
  const note = 'mode: off\n- on\n'
  const rendered = coreRequest<string>('render', { ...config, valuesOverrides: {
    'kata-deploy': { nodeSelector: { on: 'off', answer: 'yes', date: '2026-11-07', clock: '12:30' }, customNote: note },
  } })
  const values = parse(rendered, { version: '1.1' })
  assert.equal(values['kata-deploy'].nodeSelector.on, 'off')
  assert.equal(values['kata-deploy'].nodeSelector.answer, 'yes')
  assert.equal(values['kata-deploy'].nodeSelector.date, '2026-11-07')
  assert.equal(values['kata-deploy'].nodeSelector.clock, '12:30')
  assert.equal(values['kata-deploy'].customNote, note)
})


test('MicroK8s rejects EROFS by snapshotter while allowing Nydus CPU and CoCo profiles', () => {
  const micro = { ...config, distribution: 'microk8s' }
  assert.throws(() => coreRequest('generate', { ...micro, runtimes: ['qemu-nvidia-cpu-runtime-rs'] }), /EROFS requires containerd 2.2/)
  for (const runtime of ['qemu-coco-dev-runtime-rs', 'qemu-nvidia-cpu-tdx-runtime-rs', 'qemu-nvidia-cpu-snp-runtime-rs']) {
    assert.doesNotThrow(() => coreRequest('generate', { ...micro, runtimes: [runtime] }))
  }
  assert.throws(() => coreRequest('generate', { ...micro, advanced: { customRuntimes: [{
    name: 'custom-erofs', baseConfig: 'qemu-nvidia-cpu-runtime-rs',
    dropIn: '', runtimeClass: 'kata-custom-erofs', inheritBaseOverhead: true,
  }] } }), /EROFS requires containerd 2.2/)
})
