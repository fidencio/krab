import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { parseAllDocuments } from 'yaml'

test('Helm accepts EROFS as an explicit requirement alongside CPU and GPU requirements', () => {
  const rendered = execFileSync('helm', ['template', 'krab-conformance', 'charts/precheck', '--values', '-'],
    { encoding: 'utf8', input: 'conformance:\n  enabled: true\n  requirements: [tdx, gpu-cc, erofs]\n' })
  const job = parseAllDocuments(rendered).map((document) => document.toJS())
    .find((resource) => resource?.kind === 'Job' && resource.metadata.name.endsWith('-conformance'))
  const args: string[] = job.spec.template.spec.containers[0].args
  assert.deepEqual(args.slice(args.indexOf('--require')), ['--require', 'tdx', '--require', 'gpu-cc', '--require', 'erofs'])
})
