import { EquirectangularReflectionMapping, type Texture } from 'three'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'

/**
 * HDRI loading for the environment system (ported from prism's
 * apply-environment.ts). The loaded texture serves two roles: scene IBL
 * (`scene.environment`) and — via the holder below — the visible backdrop
 * sampled by the post pipeline and the site horizon disc.
 */

export const DEFAULT_HDRI_URL = 'https://threejs.org/examples/textures/equirectangular/venice_sunset_1k.hdr'

/** EXR magic bytes (little-endian 0x01312F76). */
const EXR_MAGIC_BYTES = [0x76, 0x2f, 0x31, 0x01]

/** data: URIs have no extension — sniff the decoded head for the EXR magic. */
function sniffExrMagicFromDataUrl(url: string): boolean {
  const commaIndex = url.indexOf(',')
  if (commaIndex < 0) return false
  try {
    // 16 base64 chars cover the first 12 bytes — enough for the 4-byte magic.
    const head = atob(url.slice(commaIndex + 1, commaIndex + 17))
    return EXR_MAGIC_BYTES.every((byte, index) => head.charCodeAt(index) === byte)
  } catch {
    return false
  }
}

/** Pick the EXR / Radiance HDR loader: extension first, data: URIs by magic. */
export function isExrUrl(url: string): boolean {
  if (/\.exr($|\?)/i.test(url)) return true
  return url.startsWith('data:') && sniffExrMagicFromDataUrl(url)
}

export async function loadHdrTexture(url: string): Promise<Texture> {
  const texture = isExrUrl(url)
    ? await new EXRLoader().loadAsync(url)
    : await new HDRLoader().loadAsync(url)
  texture.mapping = EquirectangularReflectionMapping
  return texture
}

// Whichever HDRI scene-environment most recently loaded. Read by
// environment-backdrop.ts — pure node-graph code with no React access — so
// the post pipeline and the horizon disc sample the same texture the IBL
// uses. Null until the first successful load (backdrop falls back to the
// theme gradient).
let hdriBackdropTexture: Texture | null = null

export function getHdriBackdropTexture(): Texture | null {
  return hdriBackdropTexture
}

export function setHdriBackdropTexture(texture: Texture | null): void {
  hdriBackdropTexture = texture
}
