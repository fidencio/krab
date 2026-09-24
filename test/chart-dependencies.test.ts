import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse, parseDocument } from 'yaml'
import {
  syncChartDependencies,
  type KrabDependencies,
} from '../scripts/sync-chart-dependencies.ts'

test('dependency sync restores upstream versions and preserves KRAB gates', async () => {
  const original = await readFile(
    resolve(import.meta.dirname, '../charts/krab/Chart.yaml'),
    'utf8',
  )
  const chart = parse(original)
  const expected = Object.fromEntries(
    chart.dependencies.map(({ name, version, repository }: {
      name: string
      version: string
      repository: string
    }) => [name, { version, repository }]),
  ) as KrabDependencies
  const staleChart = parseDocument(original)
  staleChart.setIn(['dependencies', 0, 'version'], 'old-nfd')
  staleChart.setIn(['dependencies', 2, 'repository'], 'oci://example.com/old-plugin')

  const updated = syncChartDependencies(staleChart.toString(), expected)
  assert.equal(updated, original)
  assert.equal(syncChartDependencies(updated, expected), updated)
  assert.equal(parse(updated).dependencies[2].condition, 'nvidia.enabled')
  assert.throws(
    () => syncChartDependencies(original.replace('name: kata-deploy', 'name: other'), expected),
    /Unexpected or duplicate KRAB dependency/,
  )
})
