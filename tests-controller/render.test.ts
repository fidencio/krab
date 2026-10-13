import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { parseAllDocuments } from 'yaml'
import test from 'node:test'
import { render } from '../controller/render.ts'

const options = { namespace: 'kata-system', name: 'krab-controller', image: 'krab-controller:test' }
function helm(...args: string[]) {
  return execFileSync('helm', ['template', 'krab', 'charts/krab', '--namespace', options.namespace, ...args], { encoding: 'utf8' })
}
const kata = ['--set', 'kata-deploy.deploymentMode=job', '--set', 'kata-deploy.shims.qemu.enabled=true']
function objects(output: string) {
  return parseAllDocuments(output).map(d => {
    assert.deepEqual(d.errors, [])
    return d.toJS()
  }).filter(Boolean)
}

test('pinned Kata installers become one controller with narrow RBAC', () => {
  const input = helm(...kata)
  const result = objects(render(input, options))
  const plan = JSON.parse(result.find(r => r.metadata.name === 'krab-controller-plan').data['plan.json'])
  assert.equal(plan.stages.length, 1)
  assert.equal(plan.stages[0].component, 'kata-deploy')
  assert.deepEqual(plan.stages[0].handlers, ['kata-qemu'])
  assert.equal(plan.stages[0].template.spec.template.spec.automountServiceAccountToken, false)
  assert.equal(plan.stages[0].labels['katacontainers.io/kata-runtime'], 'true')
  assert.ok(!result.some(r => r.kind === 'Job' && /kata-deploy/.test(r.metadata.name)))
  assert.ok(result.some(r => r.kind === 'RuntimeClass'))
  assert.ok(result.some(r => r.kind === 'DaemonSet' && /node-feature-discovery-worker/.test(r.metadata.name)))
  const roles = result.filter(r => ['Role', 'ClusterRole'].includes(r.kind) && /krab-controller/.test(r.metadata.name))
  assert.deepEqual(roles.flatMap(r => r.rules).filter(r => r.resources.includes('nodes')),
    [{ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list', 'patch'] }])
  assert.ok(roles.every(r => r.rules.every((rule: { resources: string[] }) => !rule.resources.some(resource => ['secrets', 'pods', 'pods/exec', 'nodes/proxy'].includes(resource)))))
  assert.deepEqual(roles.flatMap(r => r.rules).find(r => r.resources.includes('jobs')).verbs, ['create', 'get', 'list'])
  assert.ok(!result.some(r => ['Role', 'ClusterRole'].includes(r.kind) && /kata-deploy/.test(r.metadata.name)))
})

test('multiple GPU profile templates share the controller and preserve the device plugin', () => {
  const input = helm(...kata, '--set', 'nvidia.enabled=true',
    '--set', 'kata-device-provisioner.profiles.hopper.enabled=true',
    '--set', 'kata-device-provisioner.profiles.hopper.ccMode=off',
    '--set', 'kata-device-provisioner.profiles.hopper.nodeSelector.kubernetes\\.io/arch=amd64',
    '--set', 'kata-device-provisioner.profiles.blackwell.ccMode=on',
    '--set', 'kata-device-provisioner.profiles.blackwell.enabled=true',
    '--set', 'kata-device-provisioner.profiles.blackwell.nodeSelector.kubernetes\\.io/arch=arm64')
  const result = objects(render(input, options))
  const plan = JSON.parse(result.find(r => r.metadata.name === 'krab-controller-plan').data['plan.json'])
  assert.equal(plan.stages.length, 3)
  assert.equal(plan.stages.filter((s: { component: string }) => s.component === 'kata-device-provisioner').length, 2)
  assert.ok(result.some(r => r.kind === 'DaemonSet' && /kata-device-plugin/.test(r.metadata.name)))
  assert.ok(!result.some(r => r.kind === 'Job' && /provision.*dispatcher/.test(r.metadata.name)))
})

test('unsafe or unsupported combinations fail before applying resources', () => {
  assert.throws(() => render(helm(), options), /deploymentMode=job/)
  assert.throws(() => render(helm(...kata, '--set', 'kata-deploy.job.reconcile.enabled=true'), options), /Disable/)
  assert.throws(() => render(helm(...kata).replaceAll('--parallelism=100', '--unknown-flag=100'), options), /Unsupported dispatcher argument/)
  assert.throws(() => render(helm(...kata), { ...options, parallelism: 0 }), /Parallelism/)
})

test('GPU-only onboarding keeps NFD, the device plugin and QGS native workloads', () => {
  const input = helm('--set', 'kata-deploy.enabled=false', '--set', 'nvidia.enabled=true',
    '--set', 'intel-tdx-qgs.enabled=true',
    '--set', 'kata-device-provisioner.profiles.gpu.enabled=true',
    '--set', 'kata-device-provisioner.profiles.gpu.ccMode=off')
  const result = objects(render(input, options))
  const plan = JSON.parse(result.find(r => r.metadata.name === 'krab-controller-plan').data['plan.json'])
  assert.equal(plan.stages.length, 1)
  assert.equal(plan.stages[0].component, 'kata-device-provisioner')
  assert.ok(result.some(r => r.kind === 'DaemonSet' && /kata-device-plugin/.test(r.metadata.name)))
  assert.ok(result.some(r => r.kind === 'DaemonSet' && /qgs/.test(r.metadata.name)))
  assert.ok(result.some(r => r.kind === 'DaemonSet' && /node-feature-discovery-worker/.test(r.metadata.name)))
})
