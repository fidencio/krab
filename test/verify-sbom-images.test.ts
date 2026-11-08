import assert from 'node:assert/strict'
import test from 'node:test'
import { missingImages } from '../scripts/verify-sbom-images.ts'

test('rendered images must appear in the chart SBOM', () => {
  const render = `apiVersion: v1
kind: Pod
spec:
  containers:
    - name: test
      image: example.org/app:1.0.0
  initContainers:
    - name: setup
      image: example.org/setup@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`
  const sbom = {
    packages: [
      { name: 'example.org/app', versionInfo: '1.0.0', primaryPackagePurpose: 'CONTAINER' },
      { name: 'example.org/setup', versionInfo: `sha256:${'a'.repeat(64)}`, primaryPackagePurpose: 'CONTAINER' },
    ],
  }
  assert.deepEqual(missingImages(sbom, [render]), [])
  assert.deepEqual(missingImages({ packages: sbom.packages.slice(0, 1) }, [render]),
    [`example.org/setup@sha256:${'a'.repeat(64)}`])
})
