import { readFile, writeFile } from 'node:fs/promises'

const [indexPath, version] = process.argv.slice(2)
if (!indexPath || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Expected an archived index.html path and release version')
}

const html = await readFile(indexPath, 'utf8')
if (!html.includes('</body>') || html.includes('release-notice.js')) {
  throw new Error(`Cannot add the release notice to ${indexPath}`)
}

const script = `<script defer src="../release-notice.js" data-release-version="${version}"></script>`
await writeFile(indexPath, html.replace('</body>', `${script}</body>`))
