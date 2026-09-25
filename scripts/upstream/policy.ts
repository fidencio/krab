import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireValue } from './sources.ts'

type VendorPresentation = {
  id: string
  displayName: string
  tagline: string
  description: string
  logo: string
}

export type Compatibility = {
  schemaVersion: number
  teeSelectors: Record<string, Record<string, string>>
  teeSelectorEvidence: Record<string, string>
  families: Record<string, {
    displayName: string
    supportedArches: string[]
    availability: 'available' | 'pending'
    availabilityReason: string | null
    evidence: string[]
    profiles: Record<string, { sourceId: string; mode: string; cpuTees: string[] }>
  }>
  modelAliases: Record<string, string[]>
}

export const teeVendorShims = {
  amd: 'qemu-snp-runtime-rs',
  ibm: 'qemu-se-runtime-rs',
  intel: 'qemu-tdx-runtime-rs',
}

export async function loadPolicies(root: string) {
  const compatibility = JSON.parse(await readFile(resolve(root, 'upstream/compatibility.json'), 'utf8')) as Compatibility
  if (compatibility.schemaVersion !== 1) throw new Error('Unsupported compatibility matrix')

  const presentation = JSON.parse(await readFile(resolve(root, 'upstream/presentation.json'), 'utf8')) as {
    schemaVersion: number
    vendors: VendorPresentation[]
  }
  const vendorIds = ['nvidia', 'custom', ...Object.keys(teeVendorShims)]
  if (presentation.schemaVersion !== 1 || !Array.isArray(presentation.vendors) ||
      presentation.vendors.length !== vendorIds.length) {
    throw new Error('Unsupported vendor presentation file')
  }
  const presentationById = new Map(presentation.vendors.map((vendor) => [vendor.id, vendor]))
  if (presentationById.size !== vendorIds.length ||
      vendorIds.some((id) => !presentationById.has(id))) {
    throw new Error('Vendor presentation IDs must match the supported paths')
  }
  for (const vendor of presentation.vendors) {
    if (!['displayName', 'tagline', 'description', 'logo'].every((field) =>
      typeof vendor[field as keyof VendorPresentation] === 'string' &&
      vendor[field as keyof VendorPresentation].trim())) {
      throw new Error(`${vendor.id} is missing presentation text or a logo`)
    }
    if (!/^[a-z0-9-]+\.(svg|png)$/.test(vendor.logo)) {
      throw new Error(`${vendor.id} has an invalid logo filename`)
    }
    await readFile(resolve(root, 'src/assets/brands', vendor.logo))
  }
  const presentationFor = (id: string) => {
    const vendor = requireValue(presentationById.get(id), `Missing vendor presentation: ${id}`)
    return {
      displayName: vendor.displayName,
      tagline: vendor.tagline,
      description: vendor.description,
      logo: vendor.logo,
    }
  }
  return { compatibility, presentation, presentationFor }
}
