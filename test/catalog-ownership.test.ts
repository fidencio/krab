import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const catalog = JSON.parse(readFileSync(resolve(root, 'src/generated/catalog.json'), 'utf8'))
const owners = JSON.parse(readFileSync(resolve(root, 'scripts/upstream/catalog-owners.json'), 'utf8')) as Record<string, string>

const leaves = (value: unknown, path = ''): string[] => {
  if (Array.isArray(value)) {
    return value.length === 0
      ? [`${path}[]`]
      : value.flatMap((item) => leaves(item, `${path}[]`))
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value)
    return fields.length === 0
      ? [path]
      : fields.flatMap(([key, item]) => leaves(item, path ? `${path}.${key}` : key))
  }
  return [path]
}

const matches = (pattern: string, path: string) => {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  const expression = escaped.replace(/\*\*/g, '__DOUBLE_STAR__').replace(/\*/g, '[^.]*').replace(/__DOUBLE_STAR__/g, '.*')
  return new RegExp(`^${expression}$`).test(path)
}

test('every generated catalog field has a declared owner', () => {
  const paths = [...new Set(leaves(catalog))]
  const missing = paths.filter((path) => !Object.keys(owners).some((pattern) => matches(pattern, path)))
  assert.deepEqual(missing, [], 'Add each new field to scripts/upstream/catalog-owners.json and explain its source in OWNERS.md')

  for (const [pattern, owner] of Object.entries(owners)) {
    assert.ok(owner.trim(), `${pattern} has no owner`)
    assert.ok(paths.some((path) => matches(pattern, path)), `${pattern} matches no generated field`)
  }
})
