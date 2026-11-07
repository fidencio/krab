export const cliRepository = 'https://github.com/fidencio/krab'
export const cliPlatforms = [
  { label: 'Linux · x86_64', id: 'linux-amd64' },
  { label: 'Linux · ARM64', id: 'linux-arm64' },
  { label: 'macOS · Apple Silicon', id: 'darwin-arm64' },
] as const
export const cliReleaseUrl = (version: string) => `${cliRepository}/releases/tag/chart-v${version}`
export const cliAssetBase = (version: string) => `${cliRepository}/releases/download/chart-v${version}`
export const cliArchiveUrl = (version: string, platform: string) =>
  `${cliAssetBase(version)}/krab-${version}-${platform}.tar.gz`
