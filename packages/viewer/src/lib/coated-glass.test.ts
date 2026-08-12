// @ts-expect-error — bun:test is provided by the Bun runtime; viewer does not
// depend on @types/bun so the import type is unresolved at compile time.
import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import {
  coatedGlassLayersFromMaterial,
  createCoatedGlassMaterial,
  dielectricFresnelScalar,
  installLayerWeightGlass,
  isCoatedGlassMaterial,
} from './coated-glass'

describe('dielectricFresnelScalar', () => {
  test('normal incidence equals ((eta-1)/(eta+1))^2', () => {
    expect(dielectricFresnelScalar(1, 1.5)).toBeCloseTo(0.04, 6)
    expect(dielectricFresnelScalar(1, 1.52)).toBeCloseTo(((1.52 - 1) / (1.52 + 1)) ** 2, 8)
  })

  test('grazing incidence approaches 1', () => {
    expect(dielectricFresnelScalar(0, 1.5)).toBeCloseTo(1, 6)
    expect(dielectricFresnelScalar(0.001, 1.5)).toBeGreaterThan(0.99)
  })

  test('eta of 1 has no reflection at any angle', () => {
    expect(dielectricFresnelScalar(1, 1)).toBeCloseTo(0, 8)
    expect(dielectricFresnelScalar(0.5, 1)).toBeCloseTo(0, 8)
    expect(dielectricFresnelScalar(0, 1)).toBeCloseTo(0, 8)
  })

  test('increases monotonically as the view grazes', () => {
    const eta = 1.52
    const angles = [1, 0.8, 0.6, 0.4, 0.2, 0.05]
    const values = angles.map((cosine) => dielectricFresnelScalar(cosine, eta))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
  })
})

describe('coatedGlassLayersFromMaterial', () => {
  const materialWith = (pascalMaterial: unknown): THREE.Material => {
    const material = new THREE.MeshStandardMaterial()
    material.userData.pascal_material = pascalMaterial
    return material
  }

  test('parses the layer-weight object form', () => {
    const layers = coatedGlassLayersFromMaterial(
      materialWith({
        type: 'layer-weight',
        layers: [
          { ior: 1.52, color: '#dfe9f2' },
          { ior: 1.38, color: '#6f8ba8' },
        ],
      }),
    )
    expect(layers).toEqual([
      { ior: 1.52, color: '#dfe9f2' },
      { ior: 1.38, color: '#6f8ba8' },
    ])
  })

  test('ignores the string (curated ref) form', () => {
    expect(coatedGlassLayersFromMaterial(materialWith('library:glass-clear'))).toBeNull()
  })

  test('ignores missing or malformed declarations', () => {
    expect(coatedGlassLayersFromMaterial(new THREE.MeshStandardMaterial())).toBeNull()
    expect(coatedGlassLayersFromMaterial(materialWith({ type: 'layer-weight' }))).toBeNull()
    expect(
      coatedGlassLayersFromMaterial(
        materialWith({ type: 'other', layers: [{ ior: 1.5, color: '#fff' }] }),
      ),
    ).toBeNull()
    expect(
      coatedGlassLayersFromMaterial(materialWith({ type: 'layer-weight', layers: [] })),
    ).toBeNull()
    expect(
      coatedGlassLayersFromMaterial(
        materialWith({ type: 'layer-weight', layers: [{ ior: 0.5, color: '#fff' }] }),
      ),
    ).toBeNull()
    expect(
      coatedGlassLayersFromMaterial(
        materialWith({ type: 'layer-weight', layers: [{ ior: 1.5, color: 12 }] }),
      ),
    ).toBeNull()
  })
})

describe('installLayerWeightGlass', () => {
  const layers = [
    { ior: 1.52, color: '#dfe9f2' },
    { ior: 1.45, color: '#9fb8cc' },
    { ior: 1.38, color: '#6f8ba8' },
  ]

  test('installs color/ior nodes, FrontSide, and the userData marker', () => {
    const material = new THREE.MeshPhysicalMaterial()
    installLayerWeightGlass(material, layers)

    const carrier = material as THREE.MeshPhysicalMaterial & {
      colorNode?: unknown
      iorNode?: unknown
    }
    expect(carrier.colorNode).toBeDefined()
    expect(carrier.iorNode).toBeDefined()
    expect(material.side).toBe(THREE.FrontSide)
    expect(isCoatedGlassMaterial(material)).toBe(true)
    expect(material.userData.pascalCoatedGlass).toEqual({ layers })
  })
})

describe('createCoatedGlassMaterial', () => {
  const layers = [
    { ior: 1.52, color: '#dfe9f2' },
    { ior: 1.38, color: '#6f8ba8' },
  ]

  test('upgrades a standard material without mutating the authored one', () => {
    const authored = new THREE.MeshStandardMaterial({ color: '#88ccff' })
    const resolved = createCoatedGlassMaterial(authored, layers)

    expect(resolved).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    expect(resolved).not.toBe(authored)
    expect(isCoatedGlassMaterial(resolved)).toBe(true)
    expect(isCoatedGlassMaterial(authored)).toBe(false)
    expect((resolved as THREE.MeshPhysicalMaterial).color.getHexString()).toBe(
      authored.color.getHexString(),
    )
  })

  test('clones an already-physical authored material', () => {
    const authored = new THREE.MeshPhysicalMaterial({ color: '#88ccff' })
    const resolved = createCoatedGlassMaterial(authored, layers)

    expect(resolved).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    expect(resolved).not.toBe(authored)
    expect(isCoatedGlassMaterial(authored)).toBe(false)
  })

  test('caches per authored material and layers', () => {
    const authored = new THREE.MeshStandardMaterial()
    const first = createCoatedGlassMaterial(authored, layers)
    const second = createCoatedGlassMaterial(authored, layers)
    const differentLayers = createCoatedGlassMaterial(authored, [layers[0]!])

    expect(second).toBe(first)
    expect(differentLayers).not.toBe(first)
  })
})
