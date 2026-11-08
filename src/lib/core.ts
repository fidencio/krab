import init from '../generated/engine/engine.js'

/** Browser and Node boundary to the same Rust library used by the native CLI. */
type Engine = {
  memory: WebAssembly.Memory
  krab_alloc: (length: number) => number
  krab_free: (pointer: number, length: number) => void
  krab_request: (pointer: number, length: number) => bigint
}
const url = new URL('../generated/engine/engine_bg.wasm', import.meta.url)
const bytes = typeof window === 'undefined'
  ? new Uint8Array(await (await import(/* @vite-ignore */ 'node:fs/promises')).readFile(url))
  : new Uint8Array(await (await fetch(url)).arrayBuffer())
const engine = await init({ module_or_path: bytes as BufferSource }) as unknown as Engine
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function coreRequest<T>(operation: string, config?: unknown, catalog?: unknown, data?: unknown): T {
  const input = encoder.encode(JSON.stringify({ operation, config, catalog, data }))
  const pointer = engine.krab_alloc(input.length) >>> 0
  let output = 0
  let length = 0
  try {
    new Uint8Array(engine.memory.buffer, pointer, input.length).set(input)
    const packed = BigInt.asUintN(64, engine.krab_request(pointer, input.length))
    output = Number(packed >> 32n)
    length = Number(packed & 0xffffffffn)
    const response = JSON.parse(decoder.decode(new Uint8Array(engine.memory.buffer, output, length)))
    if ('error' in response) throw new Error(response.error)
    return response.value as T
  } finally {
    engine.krab_free(pointer, input.length)
    if (output) engine.krab_free(output, length)
  }
}

const embeddedCatalog = coreRequest<unknown>('catalog')
export let productError: string | null = null
async function configuredCatalog(): Promise<unknown> {
  if (typeof window === 'undefined') return embeddedCatalog
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}krab-profile.json`, {
      headers: { Accept: 'application/json' }, cache: 'no-store',
    })
    if (response.status === 404) return embeddedCatalog
    if (!response.ok) throw new Error(`Product profile could not be loaded (${response.status}).`)
    return coreRequest('product', undefined, embeddedCatalog, await response.json())
  } catch (error) {
    productError = error instanceof Error ? error.message : 'Invalid product profile.'
    return embeddedCatalog
  }
}
export const coreCatalog = await configuredCatalog()
export const coreDefaults = coreRequest<unknown>('defaults')
export const coreVersion = coreRequest<string>('version')
