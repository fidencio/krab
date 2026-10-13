import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parse, parseAllDocuments, stringify } from 'yaml'

// This adapter deliberately supports the pinned chart contracts, not arbitrary
// Job dispatchers. Unknown dispatcher flags fail before Helm changes anything.
type Resource = Record<string, any>
const supported = new Set([
  'job-template', 'cleanup-job-template', 'name-prefix', 'owner-job-name',
  'parallelism', 'tracking-label-prefix', 'node-label-key', 'instance-label-prefix',
  'multi-install-suffix', 'require-node-runtime-version', 'require-node-machine-id',
  'node-label', 'extra-node-label', 'claim-node-pending', 'node-label-pending-value',
  'wait-node-ready-secs', 'require-node-handlers', 'nodes', 'node-selector',
  'wait-for-nodes-secs', 'node-settle-secs', 'remove-node-taints',
])

export function render(input: string, options: {
  namespace: string; name: string; image: string; parallelism?: number
}) {
  const { namespace, name, image } = options
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 40) {
    throw new Error('Controller name must be a DNS label of at most 40 characters')
  }
  const parallelism = options.parallelism ?? 2
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 100) {
    throw new Error('Parallelism must be an integer between 1 and 100')
  }
  const documents = parseAllDocuments(input)
  const entries = documents.map(document => {
    if (document.errors.length) throw new Error(document.errors.join('\n'))
    return { resource: document.toJS() as Resource, source: document.toString() }
  }).filter(entry => entry.resource)
  const components = ['kata-deploy', 'kata-device-provisioner']
  const componentOf = (source: string) => components.find(component =>
    source.includes(`/charts/${component}/templates/`))
  const resources = entries.map(entry => entry.resource)
  const stages: Resource[] = []
  for (const { resource, source } of entries) {
    const component = componentOf(source)
    if (!component) continue
    if (resource.kind === 'DaemonSet' && component === 'kata-deploy') {
      throw new Error('Controller requires kata-deploy.deploymentMode=job')
    }
    if (resource.kind === 'CronJob') throw new Error('Disable kata-deploy.job.reconcile.enabled')
    if (resource.kind !== 'Job' || !resource.metadata.annotations?.['helm.sh/hook']?.includes('post-install')) continue
    const pod = resource.spec.template.spec
    const container = pod.containers.find((c: Resource) =>
      [...(c.command ?? []), ...(c.args ?? [])].includes('/usr/bin/k8s-job-dispatcher'))
    if (!container) continue
    if (resource.metadata.namespace && resource.metadata.namespace !== namespace) {
      throw new Error('Controller namespace must match the KRAB release namespace')
    }
    const flags: Record<string, string[]> = {}
    for (const arg of [...(container.command ?? []), ...(container.args ?? [])].slice(1)) {
      const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
      if (!match || !supported.has(match[1])) throw new Error(`Unsupported dispatcher argument: ${arg}`)
      ;(flags[match[1]] ??= []).push(match[2] ?? 'true')
    }
    const templatePath = flags['job-template']?.[0]
    const mount = container.volumeMounts.find((m: Resource) => templatePath?.startsWith(`${m.mountPath}/`))
    const volume = pod.volumes.find((v: Resource) => v.name === mount?.name)
    const config = resources.find(r => r.kind === 'ConfigMap' && r.metadata.name === volume?.configMap?.name)
    const template = parse(config?.data?.[templatePath?.slice(mount.mountPath.length + 1)])
    if (template?.kind !== 'Job') throw new Error(`Missing Job template for ${resource.metadata.name}`)
    if (template.spec.template.spec.automountServiceAccountToken !== false) {
      throw new Error('Installer template must disable ServiceAccount token mounting')
    }
    const labels: Record<string, string> = {}
    if (flags['node-label-key']) labels[flags['node-label-key'][0]] = flags['node-label'][0]
    for (const value of flags['extra-node-label'] ?? []) {
      const separator = value.indexOf('=')
      if (separator < 1) throw new Error(`Invalid extra label ${value}`)
      labels[value.slice(0, separator)] = value.slice(separator + 1)
    }
    if (flags['instance-label-prefix']) {
      labels[`${flags['instance-label-prefix'][0]}/${flags['multi-install-suffix']?.[0] ?? 'default'}`] = flags['node-label']?.[0] ?? 'true'
    }
    if (flags['remove-node-taints']) throw new Error('Startup taint removal is not supported by this prototype')
    const stage = {
      id: resource.metadata.name, component, template, labels,
      selectors: flags['node-selector'] ?? [''],
      nodes: flags.nodes?.[0].split(',') ?? [],
      handlers: flags['require-node-handlers']?.[0].split(',') ?? [],
      pendingLabel: flags['claim-node-pending'] ? flags['node-label-key']?.[0] : null,
      pendingValue: flags['node-label-pending-value']?.[0] ?? 'false',
    }
    stages.push({ ...stage, revision: createHash('sha256').update(JSON.stringify(stage)).digest('hex') })
  }
  // Preserve upstream hook ordering, with a stable order for profiles. Each
  // node gets only one mutation Job at a time regardless of component.
  stages.sort((a, b) => a.component.localeCompare(b.component) || a.id.localeCompare(b.id))
  if (!stages.length) throw new Error('No supported installer stages found; enable Kata job mode or GPU provisioning')
  const kept = entries.filter(({ resource, source }) => {
    if (!componentOf(source)) return true
    return !['Job', 'CronJob', 'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding'].includes(resource.kind)
  }).map(entry => entry.resource)
  const metadata = (suffix = '') => ({ name: name + suffix, namespace })
  const subject = [{ kind: 'ServiceAccount', name, namespace }]
  const plan = { version: 1, stages, parallelism, guardImage: image }
  const json = JSON.stringify(plan)
  if (Buffer.byteLength(json) > 700_000) throw new Error('Controller plan exceeds prototype ConfigMap size budget')
  const clusterName = `${namespace}-${name}`
  const added: Resource[] = [
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: metadata(), automountServiceAccountToken: false },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: metadata('-worker'), automountServiceAccountToken: false },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('-plan'), data: { 'plan.json': json } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('-state'), data: {} },
    { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: metadata('-leader'), spec: {} },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: clusterName }, rules: [
      { apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list', 'patch'] },
    ] },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: clusterName },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: clusterName }, subjects: subject },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: metadata(), rules: [
      { apiGroups: ['batch'], resources: ['jobs'], verbs: ['create', 'get', 'list'] },
      { apiGroups: [''], resources: ['configmaps'], resourceNames: [name + '-state'], verbs: ['get', 'update'] },
      { apiGroups: ['coordination.k8s.io'], resources: ['leases'], resourceNames: [name + '-leader'], verbs: ['get', 'update'] },
    ] },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: metadata(),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name }, subjects: subject },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata(), spec: {
      replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: { 'krab.io/controller': name } },
      template: { metadata: { labels: { 'krab.io/controller': name }, annotations: {
        'checksum/plan': createHash('sha256').update(json).digest('hex'),
      } }, spec: {
        serviceAccountName: name, automountServiceAccountToken: true,
        securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'controller', image, args: ['--plan=/plan/plan.json', `--name=${name}`],
          env: [{ name: 'POD_NAMESPACE', value: namespace }, { name: 'POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } }],
          securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
          resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } },
          volumeMounts: [{ name: 'plan', mountPath: '/plan', readOnly: true }],
        }], volumes: [{ name: 'plan', configMap: { name: name + '-plan' } }],
      } },
    } },
  ]
  return [...kept, ...added].map(r => stringify(r)).join('---\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const image = process.env.KRAB_CONTROLLER_IMAGE
    if (!image) throw new Error('Set KRAB_CONTROLLER_IMAGE to your built controller image')
    process.stdout.write(render(readFileSync(0, 'utf8'), {
      namespace: process.env.KRAB_CONTROLLER_NAMESPACE ?? 'kata-system',
      name: process.env.KRAB_CONTROLLER_NAME ?? 'krab-controller', image,
      parallelism: Number(process.env.KRAB_CONTROLLER_PARALLELISM ?? 2),
    }))
  } catch (error) {
    process.stderr.write(`KRAB controller renderer: ${String(error)}\n`)
    process.exitCode = 1
  }
}
