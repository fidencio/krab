import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { syncReleaseVersion } from '../scripts/sync-release-version.ts'

const root = resolve(import.meta.dirname, '..')
const files = [
  'package.json',
  'package-lock.json',
  'charts/krab/Chart.yaml',
  'charts/precheck/Chart.yaml',
  'upstream/architecture.yaml',
  'README.md',
  'charts/krab/README.md',
  'CHANGELOG.md',
]

test('one package version bump updates every release copy', async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'krab-release-version-'))
  try {
    for (const path of files) {
      const target = resolve(fixture, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await readFile(resolve(root, path)))
    }
    const read = async (path: string) => readFile(resolve(fixture, path), 'utf8')
    const bump = async (version: string) => {
      const pkg = JSON.parse(await read('package.json'))
      pkg.version = version
      await writeFile(resolve(fixture, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
      await syncReleaseVersion(fixture)
      const first = await Promise.all(files.map(read))
      await syncReleaseVersion(fixture)
      assert.deepEqual(await Promise.all(files.map(read)), first)

      const lock = JSON.parse(await read('package-lock.json'))
      const chart = parse(await read('charts/krab/Chart.yaml'))
      const precheck = parse(await read('charts/precheck/Chart.yaml'))
      const architecture = parse(await read('upstream/architecture.yaml'))
      assert.equal(lock.version, version)
      assert.equal(lock.packages[''].version, version)
      assert.equal(chart.version, version)
      assert.equal(chart.appVersion, version)
      assert.equal(precheck.version, version)
      assert.equal(precheck.appVersion, version)
      assert.match(architecture.notice, new RegExp(version.replaceAll('.', '\\.')))
      assert.match(await read('README.md'), new RegExp(`--version ${version.replaceAll('.', '\\.')}`))
      assert.match(await read('charts/krab/README.md'), new RegExp(`--version ${version.replaceAll('.', '\\.')}`))
      assert.match(await read('CHANGELOG.md'), new RegExp(`## \\[${version.replaceAll('.', '\\.')}\\]`))
      return { chart, architecture }
    }

    const alpha = await bump('0.1.0-alpha.8')
    assert.equal(alpha.chart.annotations['artifacthub.io/prerelease'], 'true')
    assert.equal(alpha.architecture.status, 'prerelease')

    const stable = await bump('0.1.0')
    assert.equal(stable.chart.annotations['artifacthub.io/prerelease'], 'false')
    assert.equal(stable.architecture.status, 'stable')
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
