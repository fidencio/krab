import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { coreCatalog, coreRequest } from '../src/lib/core.ts'
import { buildCliConfiguration, importValuesBundle, type ExplorerCatalog } from '../src/lib/artifacts.ts'
import { productDefaults, productFeature, productTheme, websiteConfiguration } from '../src/lib/product.ts'

const profile = JSON.parse(readFileSync(new URL('../examples/product-profiles/coco.json', import.meta.url), 'utf8'))

test('profile palettes switch independently and choose readable accent button text', () => {
  const plain = { ...profile }
  delete plain.theme
  const baseline = coreRequest<ExplorerCatalog>('product', undefined, coreCatalog, plain)
  assert.deepEqual(productTheme(baseline, 'light'), {})
  const catalog = coreRequest<ExplorerCatalog>('product', undefined, coreCatalog, {
    ...plain, theme: { light: { pageBackground: '#fff', accent: '#ffff00' }, dark: { accent: '#003366' } },
  })
  assert.equal(productTheme(catalog, 'light')['--product-page-background'], '#fff')
  assert.equal(productTheme(catalog, 'light')['--product-on-accent'], '#000000')
  assert.equal(productTheme(catalog, 'dark')['--product-page-background'], undefined)
  assert.equal(productTheme(catalog, 'dark')['--product-on-accent'], '#ffffff')
  assert.deepEqual(coreRequest('generate', catalog.product!.defaults, catalog),
    coreRequest('generate', baseline.product!.defaults, baseline))
  assert.throws(() => coreRequest('product', undefined, coreCatalog, {
    ...plain, theme: { light: { text: 'url(https://example.com)' } },
  }), /opaque hex colour/)
})

test('product defaults round-trip through website controls with native component semantics', () => {
  const catalog = coreRequest<ExplorerCatalog>('product', undefined, coreCatalog, profile)
  const defaults = productDefaults(catalog)!
  const config = buildCliConfiguration(catalog.vendors[0], defaults.selections, defaults.cluster,
    defaults.runtime, defaults.advanced, defaults.deploymentName, catalog.plannedArchitecture.namespace)
  assert.deepEqual(coreRequest('generate', config, catalog), coreRequest('generate', catalog.product!.defaults, catalog))
  assert.equal(defaults.advanced.components.nfd, null, 'auto must remain auto through product initialization')
  assert.equal(productFeature(catalog, 'customRuntimes'), false)
  assert.equal(productFeature(catalog, 'imageOverrides'), false)
  assert.equal(productFeature(catalog, 'continuousConformance'), true)
  assert.throws(() => coreRequest('generate', { ...config, runtimes: ['qemu-runtime-rs'] }, catalog), /Unknown choice/)
  assert.equal(catalog.product!.attribution, 'Powered by KRAB')
})

test('a restricted NVIDIA CPU TDX profile retains its pinned reference data without exposing GPU options', () => {
  const catalog = coreRequest<ExplorerCatalog>('product', undefined, coreCatalog, {
    ...profile, available: { ...profile.available, runtimes: ['qemu-nvidia-cpu-tdx-runtime-rs'] },
    defaults: { ...profile.defaults, runtimes: ['qemu-nvidia-cpu-tdx-runtime-rs'] },
  })
  assert.equal(catalog.vendors[0].runtime.shims.length, 1)
  const values = coreRequest<Record<string, any>>('generate', catalog.product!.defaults, catalog)
  assert.equal(values['nvidia'].enabled, false)
  assert.equal(values['intel-tdx-qgs'].enabled, true)
})


test('reloading product values canonicalizes explicit pins and booleans without unlocking settings', () => {
  const catalog = coreRequest<ExplorerCatalog>('product', undefined, coreCatalog, profile)
  const generated = coreRequest<string>('render', catalog.product!.defaults, catalog)
  const imported = importValuesBundle(catalog, generated)
  const config = buildCliConfiguration(catalog.vendors[0], imported.selections, imported.cluster,
    imported.runtime, imported.advanced, 'coco', catalog.plannedArchitecture.namespace)
  const normalized = coreRequest<ReturnType<typeof buildCliConfiguration>>('normalizeProduct', config, catalog)
  assert.equal(normalized.components.nfd, null)
  assert.equal(normalized.advanced.images.kataDeploy.reference, '')
  assert.deepEqual(coreRequest('generate', normalized, catalog), coreRequest('generate', catalog.product!.defaults, catalog))
  const restored = websiteConfiguration(normalized)
  assert.equal(restored.advanced.components.nfd, null)
  config.advanced.images.kataDeploy.tag = 'other'
  assert.throws(() => coreRequest('normalizeProduct', config, catalog), /imageOverrides is fixed/)
  const locked = coreRequest<ExplorerCatalog>('product', undefined, coreCatalog, {
    ...profile, features: { ...profile.features, advanced: false, components: true },
  })
  assert.equal(productFeature(locked, 'components'), false)
  assert.equal(productFeature(locked, 'continuousConformance'), false)
})
