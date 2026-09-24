import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isMap, parseDocument } from 'yaml'

const run = promisify(execFile)

export type ImageLock = {
  schemaVersion: number
  reference: string
  tag: string
  digest: string
  platforms: string[]
}

export async function resolveImageLock(reference: string, tag: string): Promise<ImageLock> {
  const image = `${reference}:${tag}`
  const descriptor = JSON.parse((await run('oras', ['manifest', 'fetch', '--descriptor', image])).stdout)
  if (!/^sha256:[0-9a-f]{64}$/.test(descriptor.digest)) {
    throw new Error(`${image} has no immutable manifest digest`)
  }
  const manifest = JSON.parse((await run('oras', ['manifest', 'fetch', `${reference}@${descriptor.digest}`])).stdout)
  const platforms = (Array.isArray(manifest.manifests) ? manifest.manifests : []).map(
    (item: { platform?: { os?: string; architecture?: string } }) =>
      `${item.platform?.os}/${item.platform?.architecture}`,
  )
  if (
    ![
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
    ].includes(descriptor.mediaType) ||
    !['linux/amd64', 'linux/arm64'].every((platform) => platforms.includes(platform))
  ) {
    throw new Error(`${image} needs a published OCI index for amd64 and arm64`)
  }
  return {
    schemaVersion: 1,
    reference,
    tag,
    digest: descriptor.digest,
    platforms: ['linux/amd64', 'linux/arm64'],
  }
}

export function syncPrecheck(
  dockerfile: string,
  values: string,
  lock: ImageLock,
  image: { reference: string; tag: string },
  dispatcher: { reference: string; tag: string },
) {
  if (
    lock.schemaVersion !== 1 ||
    lock.reference !== image.reference ||
    lock.tag !== image.tag ||
    !/^sha256:[0-9a-f]{64}$/.test(lock.digest) ||
    !Array.isArray(lock.platforms) ||
    !['linux/amd64', 'linux/arm64'].every((platform) => lock.platforms.includes(platform))
  ) {
    throw new Error('Precheck image lock does not match the pinned provisioner image')
  }
  for (const architecture of ['amd64', 'arm64']) {
    const line = new RegExp(`^FROM --platform=linux/${architecture} .* AS provisioner-${architecture}$`, 'gm')
    const matches = dockerfile.match(line)
    if (matches?.length !== 1) {
      throw new Error(`Dockerfile.precheck needs one ${architecture} provisioner stage`)
    }
    dockerfile = dockerfile.replace(
      line,
      `FROM --platform=linux/${architecture} ${lock.reference}:${lock.tag}@${lock.digest} AS provisioner-${architecture}`,
    )
  }
  const document = parseDocument(values)
  if (document.errors.length) throw document.errors[0]
  if (!isMap(document.contents) || !document.contents.has('dispatcherImage')) {
    throw new Error('Precheck chart needs a dispatcherImage value')
  }
  document.set('dispatcherImage', `${dispatcher.reference}:${dispatcher.tag}`)
  return { dockerfile, values: document.toString() }
}
