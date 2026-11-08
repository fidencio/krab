import { isMap, parseDocument } from 'yaml'

type Image = {
  reference?: string
  repository?: string
  tag: string
}

export type KrabImageDefaults = {
  nfd: Image
  kataDeploy: Image
  kubectl: Image
  kataDispatcher: Image
  devicePlugin: Image
  provisioner: Image
  provisionerDispatcher: Image
}

const imagePaths: Record<keyof KrabImageDefaults, string[]> = {
  nfd: ['node-feature-discovery', 'image'],
  kataDeploy: ['kata-deploy', 'image'],
  kubectl: ['kata-deploy', 'kubectlImage'],
  kataDispatcher: ['kata-deploy', 'job', 'dispatcherImage'],
  devicePlugin: ['kata-device-plugin', 'image'],
  provisioner: ['kata-device-provisioner', 'image'],
  provisionerDispatcher: ['kata-device-provisioner', 'job', 'dispatcherImage'],
}

export function syncChartImages(content: string, images: KrabImageDefaults) {
  const document = parseDocument(content)
  if (document.errors.length) {
    throw new Error(`Invalid KRAB values: ${document.errors[0].message}`)
  }

  for (const [name, path] of Object.entries(imagePaths) as
    [keyof KrabImageDefaults, string[]][]) {
    const current = document.getIn(path, true)
    const image = images[name]
    const referenceKey = image.reference === undefined ? 'repository' : 'reference'
    const reference = image[referenceKey]
    if (!isMap(current) || !current.has(referenceKey) || !current.has('tag')) {
      throw new Error(`KRAB ${path.join('.')} must have ${referenceKey} and tag`)
    }
    if (!reference || !image.tag) {
      throw new Error(`Missing ${name} image reference or tag`)
    }
    document.setIn([...path, referenceKey], reference)
    document.setIn([...path, 'tag'], image.tag)
  }

  return document.toString()
}
