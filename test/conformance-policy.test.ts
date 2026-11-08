import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv from 'ajv'
import { parseAllDocuments } from 'yaml'

test('Helm accepts EROFS as an explicit requirement alongside CPU and GPU requirements', () => {
  const rendered = execFileSync('helm', ['template', 'krab-conformance', 'charts/precheck', '--values', '-'],
    { encoding: 'utf8', input: 'conformance:\n  enabled: true\n  requirements: [tdx, gpu-cc, erofs]\n' })
  const job = parseAllDocuments(rendered).map((document) => document.toJS())
    .find((resource) => resource?.kind === 'Job' && resource.metadata.name.endsWith('-conformance'))
  const args: string[] = job.spec.template.spec.containers[0].args
  assert.deepEqual(args.slice(args.indexOf('--require')), ['--require', 'tdx', '--require', 'gpu-cc', '--require', 'erofs'])
})

test('Helm accepts KVM-only conformance on CPU-only nodes', () => {
  const rendered = execFileSync('helm', ['template', 'krab-conformance', 'charts/precheck', '--values', '-'],
    { encoding: 'utf8', input: 'conformance:\n  enabled: true\n  requirements: [kvm]\n' })
  const job = parseAllDocuments(rendered).map((document) => document.toJS())
    .find((resource) => resource?.kind === 'Job' && resource.metadata.name.endsWith('-conformance'))
  const args: string[] = job.spec.template.spec.containers[0].args
  assert.deepEqual(args.slice(args.indexOf('--require')), ['--require', 'kvm'])
})

test('the verdict contract accepts KVM and EROFS policies and rejects unknown requirements', () => {
  const schema = JSON.parse(readFileSync('contracts/conformance-v1.schema.json', 'utf8'))
  const validate = new Ajv().compile(schema.properties.requirements)
  assert.equal(validate(['kvm']), true)
  assert.equal(validate(['tdx', 'gpu-cc', 'erofs']), true)
  assert.equal(validate(['unknown']), false)
})
