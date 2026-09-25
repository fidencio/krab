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

test('Pages serves the newest published stable release and main as Next', async () => {
  const { source, workflow } = await readWorkflow('pages')

  assert.deepEqual(workflow.on.push.branches, ['main'])
  assert.equal(workflow.concurrency.group, 'pages')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  assert.match(source, /BASE_PATH: \/\$\{\{ github\.event\.repository\.name \}\}\/dev\//)
  assert.match(source, /cp -R source\/dist\/\. site\/dev\//)
  assert.deepEqual(workflow.on.workflow_run.workflows, ['Build PR preview'])
  assert.deepEqual(workflow.on.pull_request_target.types, ['closed'])
  assert.equal(workflow.permissions['pull-requests'], 'write')
  assert.match(source, /bash source\/scripts\/compose-pr-previews\.sh site/)
  assert.match(source, /bash source\/scripts\/compose-release-builders\.sh site/)
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

test('pull requests build chart and image SBOM artifacts', async () => {
  const { source, workflow } = await readWorkflow('sbom')

  assert.deepEqual(workflow.on.pull_request.types, [
    'opened', 'synchronize', 'reopened',
  ])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.match(source, /node --import tsx scripts\/chart-sbom\.ts/)
  assert.match(source, /node --import tsx scripts\/verify-sbom-images\.ts/)
  assert.match(source, /--platform linux\/amd64,linux\/arm64,linux\/ppc64le,linux\/s390x/)
  assert.match(source, /--from oci-archive/)
  assert.match(source, /name: chart-sboms/)
  assert.match(source, /name: preflight-image-sboms/)
})
