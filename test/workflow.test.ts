import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
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
  assert.equal(workflow.concurrency.group, 'pages')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  assert.match(source, /BASE_PATH: \/\$\{\{ github\.event\.repository\.name \}\}\/dev\//)
  assert.match(source, /cp -R stable\/dist\/\. site\//)
  assert.match(source, /cp -R development\/dist\/\. site\/dev\//)
  assert.deepEqual(workflow.on.workflow_run.workflows, ['Build PR preview'])
  assert.deepEqual(workflow.on.pull_request_target.types, ['closed'])
  assert.match(source, /bash stable\/scripts\/compose-pr-previews\.sh site/)
  assert.match(source, /bash scripts\/comment-pr-previews\.sh/)
})

test('PR previews are validated before they become Pages artifacts', async () => {
  const { source, workflow } = await readWorkflow('pr-preview')

  assert.deepEqual(workflow.on.pull_request.types, [
    'opened', 'synchronize', 'reopened',
  ])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.match(source, /npm run generate/)
  assert.match(source, /git diff --exit-code/)
  assert.match(source, /npm test/)
  assert.match(source, /npm run build/)
  assert.match(source, /pr-preview-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
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
  assert.match(source, /precheck\.version/)
  assert.match(source, /cargo test --manifest-path preflight\/Cargo\.toml --locked/)
  assert.match(source, /file: Dockerfile\.precheck/)
  assert.match(source, /helm package "\$\{PRECHECK_CHART_PATH\}"/)
  assert.match(source, /helm push "\$\{precheck_package\}"/)
  assert.match(source, /dist-precheck\/krab-precheck-\*\.tgz/)
  assert.match(source, /PRECHECK_IMAGE=ghcr\.io\/fidencio\/krab-preflight:\$\{chart_version\}/)
  assert.match(source, /Verify anonymous pre-flight image access/)
  const workflows = await readdir(resolve(root, '.github/workflows'))
  assert.ok(!workflows.includes('release-precheck.yml'))
})
