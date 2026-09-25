import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type ErofsImageLock = {
  schemaVersion: 1
  reference: string
  tag: string
  digest: string
  platforms: string[]
}

export function validateErofsImageLock(lock: ErofsImageLock): void {
  if (lock.schemaVersion !== 1 ||
      lock.reference !== 'quay.io/kata-containers/erofs-utils' ||
      !/^\d+\.\d+\.\d+$/.test(lock.tag) ||
      !/^sha256:[0-9a-f]{64}$/.test(lock.digest) ||
      !['linux/amd64', 'linux/arm64'].every((platform) => lock.platforms.includes(platform))) {
    throw new Error('Invalid EROFS utility image lock')
  }
}

export async function inspectErofsImage(reference: string, tag: string): Promise<ErofsImageLock> {
  const image = `${reference}:${tag}`
  const descriptor = JSON.parse((await run('oras', ['manifest', 'fetch', '--descriptor', image])).stdout)
  if (descriptor.mediaType !== 'application/vnd.oci.image.index.v1+json' ||
      !/^sha256:[0-9a-f]{64}$/.test(descriptor.digest)) {
    throw new Error(`${image} has no OCI image index`)
  }
  const index = JSON.parse((await run('oras', ['manifest', 'fetch', `${reference}@${descriptor.digest}`])).stdout)
  const platforms = (Array.isArray(index.manifests) ? index.manifests : [])
    .filter((manifest: { platform?: { os?: string; architecture?: string } }) =>
      manifest.platform?.os === 'linux' &&
      ['amd64', 'arm64'].includes(manifest.platform.architecture ?? ''))
    .map((manifest: { platform: { architecture: string } }) =>
      `linux/${manifest.platform.architecture}`)
    .sort()
  const lock: ErofsImageLock = {
    schemaVersion: 1,
    reference,
    tag,
    digest: descriptor.digest,
    platforms,
  }
  validateErofsImageLock(lock)
  return lock
}

export async function listErofsTags(reference: string): Promise<string[]> {
  const output = (await run('oras', ['repo', 'tags', reference])).stdout
  return output.split('\n').map((tag) => tag.trim()).filter((tag) => /^\d+\.\d+\.\d+$/.test(tag))
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}
