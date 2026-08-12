import * as THREE from 'three'
import { float, mix, normalView, positionViewDirection, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

export type CoatedGlassLayer = {
  ior: number
  color: string
}

/**
 * Exact dielectric Fresnel (s + p polarisation average), TSL node form.
 * eta = relative index of refraction (incident / transmitted, >= 1).
 */
export function dielectricFresnelNode(cosine: Node<'float'>, eta: number): Node<'float'> {
  const safeEta = Math.max(eta, 1e-5)
  const cosI = cosine.abs().clamp(0, 1)
  const cosT = cosI
    .pow(2)
    .oneMinus()
    .div(safeEta * safeEta)
    .oneMinus()
    .max(0)
    .sqrt()
  const rs = cosI.mul(safeEta).sub(cosT).div(cosI.mul(safeEta).add(cosT)).pow(2)
  const rp = cosI
    .sub(cosT.mul(safeEta))
    .div(cosI.add(cosT.mul(safeEta)))
    .pow(2)
  return rs.add(rp).mul(0.5)
}

/**
 * Exact dielectric Fresnel, scalar form — same math as the node version, for
 * CPU-side normal-incidence calibration.
 */
export function dielectricFresnelScalar(cosine: number, eta: number): number {
  const cosI = Math.min(Math.max(Math.abs(cosine), 0), 1)
  const safeEta = Math.max(eta, 1e-5)
  const cosT = Math.sqrt(Math.max(1 - (1 - cosI * cosI) / (safeEta * safeEta), 0))
  const rsDenominator = Math.max(safeEta * cosI + cosT, 1e-6)
  const rpDenominator = Math.max(cosI + safeEta * cosT, 1e-6)
  const rs = ((safeEta * cosI - cosT) / rsDenominator) ** 2
  const rp = ((cosI - safeEta * cosT) / rpDenominator) ** 2
  return (rs + rp) * 0.5
}

/**
 * Coated-glass declaration carried on a GLB material through glTF extras:
 * `material.userData.pascal_material = { type: 'layer-weight', layers: [...] }`.
 * The string form of pascal_material (curated material ref) is resolved
 * elsewhere; anything unrecognised returns null.
 */
export function coatedGlassLayersFromMaterial(material: THREE.Material): CoatedGlassLayer[] | null {
  const raw = (material.userData as { pascal_material?: unknown }).pascal_material
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as { type?: unknown; layers?: unknown }
  if (candidate.type !== 'layer-weight' || !Array.isArray(candidate.layers)) return null

  const layers: CoatedGlassLayer[] = []
  for (const layer of candidate.layers) {
    if (!layer || typeof layer !== 'object') return null
    const { ior, color } = layer as { ior?: unknown; color?: unknown }
    if (typeof ior !== 'number' || !Number.isFinite(ior) || ior < 1) return null
    if (typeof color !== 'string' || color.length === 0) return null
    layers.push({ ior, color })
  }
  return layers.length > 0 ? layers : null
}

// Classic GLB materials are converted to MeshPhysicalNodeMaterial by
// StandardNodeLibrary.fromMaterial under WebGPU; the conversion copies the
// material's own properties, so a colorNode / iorNode hung on the classic
// material is carried over (verified mechanism on three r185).
type PhysicalNodeCarrier = THREE.MeshPhysicalMaterial & {
  colorNode?: Node | null
  iorNode?: Node | null
}

/**
 * Layer-weight coated glass. Each layer contributes a dielectric Fresnel
 * factor with its own IOR as the boundary eta (the air/coating boundary
 * reflectance); colours mix from the innermost layer outward, and an
 * equivalent IOR is solved from the layers' blended R0. Single-layer input
 * degenerates to constant tint + IOR-derived specular.
 */
export function installLayerWeightGlass(
  material: THREE.MeshPhysicalMaterial,
  layers: CoatedGlassLayer[],
): void {
  if (layers.length === 0) return
  const layerColors = layers.map((layer) => new THREE.Color(layer.color))
  const toLinearVec3 = (color: THREE.Color) => vec3(color.r, color.g, color.b)

  // View cosine: dot of the view-space normal and the view direction.
  const dotNV = normalView.dot(positionViewDirection)
  const factors = layers.map((layer) => dielectricFresnelNode(dotNV, layer.ior))

  // Colour graph: blend from the innermost layer outward,
  // mix(a, b, t) = a(1−t) + b·t.
  let graphColor: Node<'vec3'> = toLinearVec3(layerColors[layers.length - 1]!)
  for (let i = layers.length - 2; i >= 0; i--) {
    graphColor = mix(toLinearVec3(layerColors[i]!), graphColor, factors[i]!)
  }

  // Normal-incidence calibration: make the head-on composite colour equal the
  // authored base colour, keeping the asset's exposure matching and only
  // restoring the angular response.
  const channelOf = (color: THREE.Color, channel: number) =>
    channel === 0 ? color.r : channel === 1 ? color.g : color.b
  const normalGraph = [0, 1, 2].map((channel) => {
    let acc = channelOf(layerColors[layers.length - 1]!, channel)
    for (let i = layers.length - 2; i >= 0; i--) {
      const factor = dielectricFresnelScalar(1, layers[i]!.ior)
      acc = channelOf(layerColors[i]!, channel) * (1 - factor) + acc * factor
    }
    return Math.max(acc, 1e-6)
  })
  const calibration = vec3(
    material.color.r / normalGraph[0]!,
    material.color.g / normalGraph[1]!,
    material.color.b / normalGraph[2]!,
  )
  const carrier = material as PhysicalNodeCarrier
  carrier.colorNode = graphColor.mul(calibration)

  // Effective specular: blend the layers' R0 with the same Fresnel factors,
  // then solve back to an equivalent IOR.
  const r0Of = (ior: number) => ((Math.max(ior, 1) - 1) / (Math.max(ior, 1) + 1)) ** 2
  let effectiveR0: Node<'float'> = float(r0Of(layers[layers.length - 1]!.ior))
  for (let i = layers.length - 2; i >= 0; i--) {
    effectiveR0 = mix(r0Of(layers[i]!.ior), effectiveR0, factors[i]!)
  }
  const sqrtR0 = effectiveR0.clamp(0, 0.98).sqrt()
  carrier.iorNode = sqrtR0.add(1).div(sqrtR0.oneMinus().max(0.01))

  // DoubleSide NodeMaterial inside the MRT scene pass compiles a back-face
  // variant that misses MRT outputs and poisons the render context — same
  // constraint as glassMaterial in materials.ts.
  material.side = THREE.FrontSide
  material.userData.pascalCoatedGlass = { layers }
  material.needsUpdate = true
}

const coatedGlassCache = new Map<string, THREE.MeshPhysicalMaterial>()

/**
 * Resolve a coated-glass render material for a GLB-authored material. The
 * authored material is never mutated (the item renderer re-resolves from its
 * captured copy on every shading change), so the coating is installed on an
 * upgraded MeshPhysicalMaterial cached per authored material + layers.
 */
export function createCoatedGlassMaterial(
  authored: THREE.Material,
  layers: CoatedGlassLayer[],
): THREE.Material {
  const cacheKey = `${authored.uuid}:${JSON.stringify(layers)}`
  const cached = coatedGlassCache.get(cacheKey)
  if (cached) return cached

  let physical: THREE.MeshPhysicalMaterial
  if (authored instanceof THREE.MeshPhysicalMaterial) {
    physical = authored.clone()
  } else {
    // MeshPhysicalMaterial.copy() reads physical-only fields the source lacks
    // and throws (r185), so borrow MeshStandardMaterial.copy and keep the
    // physical fields at their defaults.
    physical = new THREE.MeshPhysicalMaterial()
    ;(
      THREE.MeshStandardMaterial.prototype.copy as (
        this: THREE.MeshPhysicalMaterial,
        source: THREE.Material,
      ) => void
    ).call(physical, authored)
    // Sources without standard fields (e.g. unlit MeshBasicMaterial) leave
    // roughness/metalness undefined after the borrowed copy.
    if (physical.roughness === undefined) physical.roughness = 1
    if (physical.metalness === undefined) physical.metalness = 0
  }

  installLayerWeightGlass(physical, layers)
  physical.userData.__pascalCachedMaterial = true
  coatedGlassCache.set(cacheKey, physical)
  return physical
}

export function isCoatedGlassMaterial(material: THREE.Material): boolean {
  return material.userData.pascalCoatedGlass !== undefined
}

export function clearCoatedGlassMaterialCache(): void {
  for (const material of coatedGlassCache.values()) {
    material.dispose()
  }
  coatedGlassCache.clear()
}
