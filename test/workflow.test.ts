import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '..')

const readWorkflow = async (name: string) => {
  const source = await readFile(
    resolve(root, `.github/workflows/${name}.yml`),
    'utf8',
  )
  return { source, workflow: parse(source) }
}

test('Pages publishes stable and development builds together', async () => {
  const { source, workflow } = await readWorkflow('pages')

  assert.deepEqual(workflow.on.push.branches, ['main', 'dev'])
  assert.match(source, /BASE_PATH: \/\$\{\{ github\.event\.repository\.name \}\}\/dev\//)
  assert.match(source, /cp -R stable\/dist\/\. site\//)
  assert.match(source, /cp -R development\/dist\/\. site\/dev\//)
})

test('chart releases require synchronized main and dev trees', async () => {
  const { source, workflow } = await readWorkflow('release-chart')

  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.match(source, /refs\/heads\/main/)
  assert.match(source, /refs\/remotes\/origin\/dev/)
  assert.match(
    source,
    /git diff --quiet HEAD refs\/remotes\/origin\/dev -- \./,
  )
})
