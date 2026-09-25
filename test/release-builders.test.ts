import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const script = resolve(import.meta.dirname, '../scripts/compose-release-builders.sh')

test('release selector includes stable releases and their archived builders', async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'krab-release-builders-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const fakeBin = resolve(fixture, 'bin')
  const archives = resolve(fixture, 'archives')
  const site = resolve(fixture, 'site')
  await mkdir(fakeBin)
  await mkdir(archives)
  await mkdir(site)
  await writeFile(resolve(fakeBin, 'gh'), `#!/bin/bash
set -euo pipefail
if [[ "$1" == api ]]; then
  if [[ "\${MOCK_NO_STABLE:-false}" == true ]]; then
    printf 'chart-v1.1.0-rc.1\\ttrue\\n'
  else
    printf 'chart-v1.0.0\\tfalse\\nchart-v1.2.0\\tfalse\\nchart-v1.1.0-rc.1\\ttrue\\n'
  fi
elif [[ "$1" == release && "$2" == download ]]; then
  tag="$3"
  shift 3
  while (( $# > 0 )); do
    if [[ "$1" == --dir ]]; then destination="$2"; break; fi
    shift
  done
  version="$(printf '%s' "$tag" | sed 's/^chart-v//')"
  cp "$MOCK_ARCHIVES/krab-builder-$version.tar.gz" "$destination/"
else
  exit 1
fi
`)
  await chmod(resolve(fakeBin, 'gh'), 0o755)
  const builder = resolve(fixture, 'builder')
  await mkdir(builder)
  await writeFile(resolve(builder, 'index.html'), '<body><title>KRAB 1.0.0</title></body>')
  execFileSync('tar', ['-czf', resolve(archives, 'krab-builder-1.0.0.tar.gz'), '-C', builder, '.'])
  await writeFile(resolve(builder, 'index.html'), '<body><title>KRAB 1.2.0</title></body>')
  execFileSync('tar', ['-czf', resolve(archives, 'krab-builder-1.2.0.tar.gz'), '-C', builder, '.'])
  await mkdir(resolve(site, 'dev'))
  await writeFile(resolve(site, 'dev/index.html'), '<title>Development</title>')

  execFileSync('bash', [script, site], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GH_REPO: 'fidencio/krab',
      MOCK_ARCHIVES: archives,
    },
  })
  assert.deepEqual(JSON.parse(await readFile(resolve(site, 'releases/manifest.json'), 'utf8')), {
    schemaVersion: 1,
    currentVersion: '1.2.0',
    releases: [
      { version: '1.2.0', tag: 'chart-v1.2.0', path: './1.2.0/index.html' },
      { version: '1.0.0', tag: 'chart-v1.0.0', path: './1.0.0/index.html' },
    ],
  })
  assert.match(await readFile(resolve(site, 'index.html'), 'utf8'), /KRAB 1\.2\.0/)
  assert.doesNotMatch(await readFile(resolve(site, 'index.html'), 'utf8'), /release-notice\.js/)
  assert.match(await readFile(resolve(site, 'releases/1.0.0/index.html'), 'utf8'), /KRAB 1\.0\.0/)
  assert.match(await readFile(resolve(site, 'releases/1.0.0/index.html'), 'utf8'),
    /release-notice\.js" data-release-version="1\.0\.0"/)

  const emptySite = resolve(fixture, 'empty-site')
  await mkdir(resolve(emptySite, 'dev'), { recursive: true })
  await writeFile(resolve(emptySite, 'dev/index.html'), '<title>Development</title>')
  execFileSync('bash', [script, emptySite], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GH_REPO: 'fidencio/krab',
      MOCK_ARCHIVES: archives,
      MOCK_NO_STABLE: 'true',
    },
  })
  assert.match(await readFile(resolve(emptySite, 'index.html'), 'utf8'), /Development/)
  assert.equal(JSON.parse(await readFile(resolve(emptySite, 'releases/manifest.json'), 'utf8')).currentVersion, null)
})
