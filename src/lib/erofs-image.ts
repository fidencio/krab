import imageLock from '../../upstream/erofs-utils-image.lock.json'

export const erofsUtilsImage = `${imageLock.reference}:${imageLock.tag}@${imageLock.digest}`
