import { createHash } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { parse, parseDocument } from 'yaml'

export const groups = {
  kata: { repository: 'kata-containers/kata-containers', chart: 'kata-deploy', prereleases: false },
  nfd: { repository: 'kubernetes-sigs/node-feature-discovery', chart: 'node-feature-discovery', prereleases: false },
  'device-plugin': { repository: 'kata-containers/kata-device-plugin', chart: 'kata-device-plugin', prereleases: true },
  provisioner: { repository: 'kata-containers/kata-device-provisioner', chart: 'kata-device-provisioner', prereleases: true },
} as const

export type Group = keyof typeof groups
type Release = { tag_name: string; draft: boolean; prerelease: boolean }
type Source = { id: string; repository: string; ref: string; release: string; path: string; sha256: string }
type GitObject = { type: string; sha: string }
type Api = <T>(path: string) => Promise<T>

const version = (tag: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(tag)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3]),
    match[4] ? { alpha: 0, beta: 1, rc: 2 }[match[4] as 'alpha' | 'beta' | 'rc'] : 3,
    Number(match[5] ?? 0)]
}

export function newerRelease(releases: Release[], current: string, group: Group) {
  const currentVersion = version(current)
  if (!currentVersion) throw new Error(`Unsupported locked ${group} release: ${current}`)
  const compare = (left: number[], right: number[]) => {
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return left[index] - right[index]
    }
    return 0
  }
  return releases
    .filter((release) => !release.draft && (groups[group].prereleases ||
      (!release.prerelease && version(release.tag_name)?.[3] === 3)))
    .filter((release) => version(release.tag_name))
    .sort((a, b) => compare(version(b.tag_name)!, version(a.tag_name)!))
    .find((release) => compare(version(release.tag_name)!, currentVersion) > 0)?.tag_name
}

export async function resolveTagCommit(repository: string, tag: string, api: Api) {
  const ref = await api<{ ref: string; object: GitObject }>(
    `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
  )
  if (ref.ref !== `refs/tags/${tag}`) throw new Error(`Unexpected tag ref for ${repository}:${tag}`)
  let object = ref.object
  for (let depth = 0; object.type === 'tag' && depth < 3; depth++) {
    const annotated = await api<{ object: GitObject }>(`/repos/${repository}/git/tags/${object.sha}`)
    object = annotated.object
  }
  if (object.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object.sha)) {
    throw new Error(`Cannot resolve ${repository}:${tag} to a commit`)
  }
  return object.sha
}

export function updateGroupLock(
  content: string,
  group: Group,
  tag: string,
  commit: string,
  files: Map<string, string>,
) {
  const document = parseDocument(content)
  if (document.errors.length) throw document.errors[0]
  const lock = document.toJS() as { schemaVersion: number; sources: Source[] }
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources)) throw new Error('Invalid source lock')
  const selected = lock.sources.map((source, index) => ({ source, index }))
    .filter(({ source }) => source.repository === groups[group].repository)
  if (!selected.length) throw new Error(`No locked sources for ${group}`)
  const chart = selected.find(({ source }) => source.id === `${group}-chart`)
  if (!chart) throw new Error(`No locked chart for ${group}`)
  const chartText = files.get(chart.source.path)
  if (!chartText) throw new Error(`${group} is missing ${chart.source.path}`)
  const metadata = parse(chartText) as { name?: string; appVersion?: string }
  if (metadata?.name !== groups[group].chart ||
      String(metadata.appVersion).replace(/^v/, '') !== tag.replace(/^v/, '')) {
    throw new Error(`${group} ${tag} chart name or appVersion does not match the release`)
  }
  for (const { source, index } of selected) {
    const body = files.get(source.path)
    if (body === undefined) throw new Error(`${group} is missing ${source.path}`)
    document.setIn(['sources', index, 'ref'], commit)
    document.setIn(['sources', index, 'release'], tag)
    document.setIn(['sources', index, 'sha256'], createHash('sha256').update(body).digest('hex'))
  }
  return document.toString()
}

async function github<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'krab-upstream-refresh',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await fetch(`https://api.github.com${path}`, { headers })
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`)
  return response.json() as Promise<T>
}

async function publishedReleases(repository: string) {
  const releases: Release[] = []
  for (let page = 1; page <= 10; page++) {
    const batch = await github<Release[]>(`/repos/${repository}/releases?per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error(`${repository} returned an invalid release list`)
    releases.push(...batch)
    if (batch.length < 100) return releases
  }
  throw new Error(`${repository} has more than 1000 releases; extend release discovery`)
}

async function main() {
  const argument = process.argv.find((item) => item.startsWith('--group='))?.slice(8) ??
    process.argv[process.argv.indexOf('--group') + 1]
  if (!Object.hasOwn(groups, argument)) throw new Error('Pass --group kata|nfd|device-plugin|provisioner')
  const group = argument as Group
  const { repository } = groups[group]
  const lockPath = resolve(import.meta.dirname, '../upstream/sources.lock.yaml')
  const content = await readFile(lockPath, 'utf8')
  const lock = parse(content) as { sources: Source[] }
  const selected = lock.sources.filter((source) => source.repository === repository)
  const current = selected[0]?.release
  if (!current || selected.some((source) => source.release !== current || source.ref !== selected[0].ref)) {
    throw new Error(`${group} locked sources disagree on their release or commit`)
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `current=${current}\n`)
  const releases = await publishedReleases(repository)
  const tag = newerRelease(releases, current, group) ??
    (/^[0-9a-f]{40}$/.test(selected[0].ref) ? undefined : current)
  if (tag && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\n`)
  if (!tag) {
    console.log(`${group} ${current} is current`)
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'changed=false\n')
    return
  }
  const commit = await resolveTagCommit(repository, tag, github)
  const downloaded = await Promise.all(selected.map(async (source) => {
    const url = `https://raw.githubusercontent.com/${repository}/${commit}/${source.path}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${group} ${tag} is missing ${source.path}: HTTP ${response.status}`)
    return [source.path, await response.text()] as const
  }))
  const files = new Map(downloaded)
  const updated = updateGroupLock(content, group, tag, commit, files)
  await writeFile(lockPath, updated)
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'changed=true\n')
  console.log(`${group}: ${current} -> ${tag} (${commit}); run npm run sync:upstream`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
