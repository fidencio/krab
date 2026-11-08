import { createAdvancedConfiguration, type ExplorerCatalog, type FamilySelections } from './artifacts'

/** Runtime colour overrides; omitted colours keep KRAB's selected light/dark palette. */
export function productTheme(catalog: ExplorerCatalog, mode: 'light' | 'dark') {
  const palette = catalog.product?.theme?.[mode] ?? {}
  const properties: Record<string, string> = {}
  for (const [field, color] of Object.entries(palette)) {
    const name = field.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
    properties[`--product-${name}`] = color
  }
  if (palette.accent) {
    const hex = palette.accent.slice(1)
    const expanded = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex
    const rgb = [0, 2, 4].map(offset => parseInt(expanded.slice(offset, offset + 2), 16) / 255)
      .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    const luminance = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2]
    properties['--product-on-accent'] = luminance > .179 ? '#000000' : '#ffffff'
  }
  if (palette.accent || palette.panelBackground) {
    properties['--product-selection'] = 'color-mix(in srgb, var(--kata-orange) 8%, var(--surface-raised))'
  }
  return properties
}

export function productFeature(catalog: ExplorerCatalog, name: string) {
  return catalog.product?.features.advanced !== false && catalog.product?.features[name] !== false
}

/** Preserve native defaults directly, including auto component choices. */
export function productDefaults(catalog: ExplorerCatalog) {
  const defaults = catalog.product?.applyDefaults ? catalog.product.defaults : undefined
  return defaults ? websiteConfiguration(defaults) : null
}

export function websiteConfiguration(defaults: NonNullable<ExplorerCatalog['product']>['defaults']) {
  return {
    vendorId: defaults.vendor,
    deploymentName: defaults.release,
    selections: Object.fromEntries(Object.entries(defaults.hardware).map(([id, choice]) =>
      [id, { enabled: true, modeId: choice.mode, cpuTeeIds: choice.cpuTees }])) as FamilySelections,
    cluster: { distributionId: defaults.distribution, architectures: defaults.architectures, selinuxEnabled: defaults.selinux },
    runtime: { selectedShimIds: defaults.runtimes, runtimeHttpsProxy: defaults.runtime.httpsProxy,
      runtimeNoProxy: defaults.runtime.noProxy, nvidiaDcgmEnabled: defaults.runtime.nvidiaDcgm },
    advanced: { ...createAdvancedConfiguration(), ...structuredClone(defaults.advanced),
      components: structuredClone(defaults.components), erofsSnapshotterMode: defaults.runtime.erofsMode,
      erofsDiskSize: defaults.runtime.erofsDiskSize, erofsDmverity: defaults.runtime.erofsDmverity,
      erofsEnableFsverity: defaults.runtime.erofsFsverity, installErofsUtils: defaults.runtime.installErofsUtils },
  }
}
