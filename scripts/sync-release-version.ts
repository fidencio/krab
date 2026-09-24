import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

async function updateFile(root: string, path: string, update: (content: string) => string) {
  const file = resolve(root, path)
  const current = await readFile(file, 'utf8')
  const next = update(current)
  if (next !== current) await writeFile(file, next)
}

function replaceLines(content: string, pattern: RegExp, replacement: string, count: number, path: string) {
  let matches = 0
  const result = content.replace(pattern, () => {
    matches += 1
    return replacement
  })
  if (matches !== count) {
    throw new Error(`${path}: expected ${count} version field(s), found ${matches}`)
  }
  return result
}

export async function syncReleaseVersion(root = resolve(import.meta.dirname, '..')) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const version = pkg.version as string
  const match = typeof version === 'string' ? version.match(semver) : null
  if (!match) throw new Error(`Invalid KRAB version in package.json: ${version}`)
  const prerelease = match[1] !== undefined

  await updateFile(root, 'package-lock.json', (content) => {
    const lock = JSON.parse(content)
    if (lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name) {
      throw new Error('package-lock.json does not belong to KRAB')
    }
    lock.version = version
    lock.packages[''].version = version
    return `${JSON.stringify(lock, null, 2)}\n`
  })

  await updateFile(root, 'charts/krab/Chart.yaml', (content) => {
    let next = replaceLines(content, /^version:.*$/gm, `version: ${version}`, 1, 'charts/krab/Chart.yaml')
    next = replaceLines(next, /^appVersion:.*$/gm, `appVersion: "${version}"`, 1, 'charts/krab/Chart.yaml')
    return replaceLines(next, /^  artifacthub\.io\/prerelease:.*$/gm,
      `  artifacthub.io/prerelease: "${prerelease}"`, 1, 'charts/krab/Chart.yaml')
  })
  await updateFile(root, 'charts/precheck/Chart.yaml', (content) => {
    let next = replaceLines(content, /^version:.*$/gm, `version: ${version}`, 1, 'charts/precheck/Chart.yaml')
    return replaceLines(next, /^appVersion:.*$/gm, `appVersion: ${version}`, 1, 'charts/precheck/Chart.yaml')
  })
  await updateFile(root, 'upstream/architecture.yaml', (content) => {
    const status = prerelease ? 'prerelease' : 'stable'
    const notice = prerelease
      ? `KRAB ${version} is prerelease software. Review generated values before deploying.`
      : `KRAB ${version}. Review generated values before deploying.`
    let next = replaceLines(content, /^status:.*$/gm, `status: ${status}`, 1, 'upstream/architecture.yaml')
    return replaceLines(next, /^notice:.*$/gm, `notice: ${notice}`, 1, 'upstream/architecture.yaml')
  })
  for (const [path, count] of [['README.md', 2], ['charts/krab/README.md', 1]] as const) {
    await updateFile(root, path, (content) =>
      replaceLines(content, /^  --version \S+ \\$/gm, `  --version ${version} \\`, count, path))
  }
  await updateFile(root, 'CHANGELOG.md', (content) => {
    if (content.includes(`## [${version}]`)) return content
    const heading = /^## \[/m
    if (!heading.test(content)) throw new Error('CHANGELOG.md has no release heading')
    return content.replace(heading, `## [${version}] - Unreleased\n\n## [`)
  })
  return { version, prerelease }
}
