import { isMap, isSeq, parseDocument } from 'yaml'

type Dependency = {
  version: string
  repository: string
}

export type KrabDependencies = Record<
  'node-feature-discovery' | 'kata-deploy' | 'kata-device-plugin' | 'kata-device-provisioner',
  Dependency
>

export function syncChartDependencies(content: string, expected: KrabDependencies) {
  const document = parseDocument(content)
  if (document.errors.length) {
    throw new Error(`Invalid KRAB chart: ${document.errors[0].message}`)
  }
  const dependencies = document.get('dependencies', true)
  if (!isSeq(dependencies) || dependencies.items.length !== Object.keys(expected).length) {
    throw new Error('KRAB chart must declare exactly four dependencies')
  }

  const seen = new Set<string>()
  dependencies.items.forEach((item, index) => {
    if (!isMap(item)) throw new Error(`Invalid KRAB dependency at index ${index}`)
    const name = item.get('name')
    if (typeof name !== 'string' || !Object.hasOwn(expected, name) || seen.has(name)) {
      throw new Error(`Unexpected or duplicate KRAB dependency: ${name}`)
    }
    if (!item.has('version') || !item.has('repository')) {
      throw new Error(`KRAB dependency ${name} needs version and repository`)
    }
    seen.add(name)
    const source = expected[name as keyof KrabDependencies]
    if (!source.version || !source.repository) {
      throw new Error(`Missing published chart metadata for ${name}`)
    }
    document.setIn(['dependencies', index, 'version'], source.version)
    document.setIn(['dependencies', index, 'repository'], source.repository)
  })

  return document.toString()
}
