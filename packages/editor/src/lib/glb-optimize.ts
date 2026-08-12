/**
 * Post-process an exported GLB: dedup → prune → quantize, with optional Draco
 * mesh compression on top. Ported from prism-studio's `compress-glb.ts` (MIT,
 * Samuel Ouyang) and extended with the dedup/prune/quantize stages that proved
 * out on an 836MB editor export (→ 345MB quantized, → 113MB draco).
 *
 * gltf-transform round-trips drop unregistered glTF extensions, so the IO
 * registers ALL_EXTENSIONS — our exports use KHR_materials_* and
 * KHR_texture_transform heavily.
 */

export type GlbCompression = 'none' | 'quantize' | 'draco'

type OptimizeOptions = {
  /** Draco encoder wasm URL; the host app serves it from public/draco/. */
  encoderWasmUrl?: string
}

const DEFAULT_ENCODER_WASM_URL = '/draco/draco_encoder.wasm'

const encoderModuleCache = new Map<string, Promise<unknown>>()

async function getEncoderModule(wasmUrl: string): Promise<unknown> {
  const cached = encoderModuleCache.get(wasmUrl)
  if (cached) return cached
  const { default: draco3dgltf } = await import('draco3dgltf')
  const pending = draco3dgltf.createEncoderModule({ locateFile: () => wasmUrl })
  encoderModuleCache.set(wasmUrl, pending)
  return pending
}

export async function optimizeGlb(
  glb: ArrayBuffer | Uint8Array,
  compression: Exclude<GlbCompression, 'none'>,
  options: OptimizeOptions = {},
): Promise<Uint8Array> {
  const [{ WebIO }, { ALL_EXTENSIONS, KHRDracoMeshCompression }, { dedup, prune, quantize }] =
    await Promise.all([
      import('@gltf-transform/core'),
      import('@gltf-transform/extensions'),
      import('@gltf-transform/functions'),
    ])

  const io = new WebIO().registerExtensions(ALL_EXTENSIONS)
  if (compression === 'draco') {
    io.registerDependencies({
      'draco3d.encoder': await getEncoderModule(options.encoderWasmUrl ?? DEFAULT_ENCODER_WASM_URL),
    })
  }

  const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb)
  const document = await io.readBinary(bytes)

  if (compression === 'draco') {
    // Draco quantizes internally — running quantize() too would double-encode
    // (bigger output, extra KHR_mesh_quantization requirement for decoders).
    // Encoded lazily at write time by the extension's prewrite hook. Same
    // default quantization tiers as gltf-transform's draco() function.
    await document.transform(dedup(), prune())
    document
      .createExtension(KHRDracoMeshCompression)
      .setRequired(false)
      .setEncoderOptions({
        method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
        encodeSpeed: 5,
        decodeSpeed: 5,
        quantizationBits: {
          POSITION: 14,
          NORMAL: 10,
          COLOR: 8,
          TEXCOORD: 12,
          GENERIC: 12,
        },
        quantizationVolume: 'mesh',
      })
  } else {
    await document.transform(dedup(), prune(), quantize())
  }

  return io.writeBinary(document)
}
