import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chartSbom } from '../scripts/chart-sbom.ts'

test('chart SBOM describes packaged subcharts and rejects missing dependencies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'krab-sbom-test-'))
  try {
    const root = join(directory, 'parent')
    const child = join(root, 'charts', 'child')
    mkdirSync(child, { recursive: true })
    writeFileSync(join(root, 'Chart.yaml'), [
      'apiVersion: v2',
      'name: parent',
      'version: 1.0.0',
      'dependencies:',
      '  - name: child',
      '    version: 2.0.0',
    ].join('\n'))
    writeFileSync(join(child, 'Chart.yaml'), [
      'apiVersion: v2',
      'name: child',
      'version: 2.0.0',
    ].join('\n'))
    writeFileSync(join(root, 'values.yaml'), [
      'child:',
      '  image:',
      '    repository: example.org/child',
      '    tag: 2.0.1',
    ].join('\n'))
    writeFileSync(join(child, 'values.yaml'), [
      'image:',
      '  repository: example.org/child',
      '  tag: 2.0.0',
    ].join('\n'))
    const archive = join(directory, 'parent.tgz')
    execFileSync('tar', ['-czf', archive, '-C', directory, 'parent'])

    const sbom = chartSbom(archive, '2026-09-25T00:00:00Z')
    assert.deepEqual(sbom.packages.filter(({ primaryPackagePurpose }) =>
      primaryPackagePurpose === 'APPLICATION').map(({ name }) => name),
    ['parent', 'child'])
    assert.ok(sbom.packages.some(({ name, versionInfo }) =>
      name === 'example.org/child' && versionInfo === '2.0.1'))
    const parentId = String(sbom.packages.find(({ name }) => name === 'parent')?.SPDXID)
    const childId = String(sbom.packages.find(({ name }) => name === 'child')?.SPDXID)
    assert.ok(sbom.relationships.some(({ spdxElementId, relatedSpdxElement }) =>
      spdxElementId === parentId && relatedSpdxElement === childId))
    assert.equal(sbom.creationInfo.created, '2026-09-25T00:00:00Z')

    rmSync(child, { recursive: true })
    execFileSync('tar', ['-czf', archive, '-C', directory, 'parent'])
    assert.throws(() => chartSbom(archive), /missing packaged dependency child@2.0.0/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
