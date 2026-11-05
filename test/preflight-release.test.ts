import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts/package-preflight-binary.py')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const revision = 'a'.repeat(40)

function elf(machine = 62, kind = 1) {
  const data = Buffer.alloc(192)
  data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  data.writeUInt16LE(2, 16)
  data.writeUInt16LE(machine, 18)
  data.writeUInt32LE(1, 20)
  data.writeBigUInt64LE(64n, 32)
  data.writeUInt16LE(64, 52)
  data.writeUInt16LE(56, 54)
  data.writeUInt16LE(1, 56)
  data.writeUInt32LE(kind, 64)
  return data
}

function argumentsFor(directory: string) {
  return [script, '--binary', join(directory, 'checker'), '--architecture', 'amd64',
    '--revision', revision, '--epoch', '1790000000', '--rustc-version', 'rustc 1.95.0 (fixture)',
    '--output', join(directory, 'out')]
}

test('standalone checker builds gate release publication and deliver both architectures', () => {
  const binaries = parse(readFileSync(join(root, '.github/workflows/preflight-binaries.yml'), 'utf8'))
  assert.ok('workflow_call' in binaries.on)
  assert.deepEqual(binaries.permissions, { contents: 'read' })
  assert.deepEqual(binaries.jobs.build.strategy.matrix.include, [
    { runner: 'ubuntu-24.04', architecture: 'amd64', target: 'x86_64-unknown-linux-musl' },
    { runner: 'ubuntu-24.04-arm', architecture: 'arm64', target: 'aarch64-unknown-linux-musl' },
  ])
  assert.equal(binaries.jobs.build.env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER, 'rust-lld')
  assert.equal(binaries.jobs.build.env.CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER, 'rust-lld')
  const buildSteps = binaries.jobs.build.steps
  assert.match(buildSteps.find((s: { name: string }) => s.name === 'Test and build the static checker').run,
    /cargo \+1\.95\.0 test --locked/)
  const smoke = buildSteps.find((s: { name: string }) => s.name === 'Verify and smoke test the packaged checker').run
  assert.match(smoke, /sha256sum --check SHA256SUMS/)
  assert.match(smoke, /checker-package\/krab-preflight/)
  assert.equal(buildSteps.at(-1).with['if-no-files-found'], 'error')

  const release = parse(readFileSync(join(root, '.github/workflows/release-chart.yml'), 'utf8'))
  assert.equal(release.jobs.preflight_binaries.uses, './.github/workflows/preflight-binaries.yml')
  assert.equal(release.jobs.release.needs, 'preflight_binaries')
  const steps = release.jobs.release.steps
  const download = steps.find((s: { uses: string }) => s.uses === 'actions/download-artifact@v5')
  assert.equal(download.with.pattern, 'krab-preflight-linux-*')
  assert.equal(download.with['merge-multiple'], true)
  assert.equal(download.with.path, 'dist-binaries')
  for (const name of ['Prepare release checksums', 'Publish GitHub release']) {
    assert.match(steps.find((s: { name: string }) => s.name === name).run, /dist-binaries\/\*\.tar\.gz/)
  }
  assert.equal(steps.find((s: { name: string }) => s.name === 'Attest standalone checker archives')
    .with['subject-path'], 'dist-binaries/*.tar.gz')
})

test('release archives are reproducible and contain the focused checker and installation digest', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'krab-binary-package-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const binary = elf()
  writeFileSync(join(directory, 'checker'), binary)
  const args = argumentsFor(directory)
  execFileSync('python3', args)
  const archive = join(directory, 'out', `krab-preflight-${version}-linux-amd64.tar.gz`)
  const first = readFileSync(archive)
  execFileSync('python3', args)
  assert.deepEqual(readFileSync(archive), first)
  const extracted = join(directory, 'extracted')
  mkdirSync(extracted)
  execFileSync('tar', ['-xzf', archive, '-C', extracted])
  assert.deepEqual(readdirSync(extracted).sort(), ['BUILD-INFO.json', 'LICENSE', 'README.md', 'SHA256SUMS', 'krab-preflight'])
  assert.deepEqual(readFileSync(join(extracted, 'krab-preflight')), binary)
  assert.equal(statSync(join(extracted, 'krab-preflight')).mode & 0o777, 0o755)
  const digest = createHash('sha256').update(binary).digest('hex')
  assert.equal(readFileSync(join(extracted, 'SHA256SUMS'), 'utf8'), `${digest}  krab-preflight\n`)
  const info = JSON.parse(readFileSync(join(extracted, 'BUILD-INFO.json'), 'utf8'))
  assert.equal(info.version, version)
  assert.equal(info.revision, revision)
  assert.equal(info.target, 'x86_64-unknown-linux-musl')
  assert.equal(info.linkage, 'static-musl')
  assert.equal(info.checkerSHA256, digest)
  const readme = readFileSync(join(extracted, 'README.md'), 'utf8')
  assert.match(readme, new RegExp(`blob/${revision}/docs/continuous-node-conformance.md`))
  assert.doesNotMatch(readme, /@VERSION@|@REVISION@/)
})

test('packaging rejects dynamic, wrong-architecture, and malformed artifacts before writing an archive', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'krab-binary-reject-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const shared = elf(62, 2)
  shared.writeBigUInt64LE(128n, 72)
  shared.writeBigUInt64LE(16n, 96)
  shared.writeBigInt64LE(1n, 128)
  for (const [binary, message] of [
    [elf(62, 3), /statically linked/],
    [shared, /shared library/],
    [elf(183), /architecture/],
    [Buffer.from('not an ELF'), /Linux ELF/],
    [elf().subarray(0, 100), /program headers/],
  ] as const) {
    writeFileSync(join(directory, 'checker'), binary)
    const output = spawnSync('python3', argumentsFor(directory), { encoding: 'utf8' })
    assert.equal(output.status, 2)
    assert.match(output.stderr, message)
    assert.deepEqual(readdirSync(directory), ['checker'])
  }
})
