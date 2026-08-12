'use client'

import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import * as THREE from 'three/webgpu'
import { loadHdrTexture, setHdriBackdropTexture } from '../../lib/hdri'
import { skyUniforms, sunDirection } from '../../lib/procedural-sky'
import { getSceneTheme } from '../../lib/scene-themes'
import useViewer from '../../store/use-viewer'

/**
 * Scene IBL + environment state for the three environment modes (see
 * lib/environment-backdrop.ts for the visible-backdrop side):
 *
 * - `gradient`: the small procedural gradient sky below (cool zenith → warm
 *   horizon → dim ground bounce) — no network, no bake.
 * - `sky`: a hidden SkyMesh (sun disc off — the sun's energy belongs to the
 *   shadow-casting directional light, baking it in would double-count) PMREM-
 *   baked into scene.environment. Debounced so sun-angle drags rebake at most
 *   every SKY_REBAKE_MS.
 * - `hdri`: the loaded HDR/EXR texture directly as IBL; also handed to the
 *   backdrop holder so the post pipeline and horizon disc can draw it.
 *
 * Exported as an opt-in <Viewer> child so embed / thumbnail surfaces that
 * don't want IBL simply don't mount it. Only affects `rendered` shading
 * (Lambert ignores env maps).
 */

// Linear-space gradient stops.
const ZENITH = [0.4, 0.56, 0.78] as const
const HORIZON = [0.95, 0.84, 0.66] as const
const GROUND = [0.38, 0.35, 0.3] as const

const ENV_INTENSITY = 0.6
// The gradient sky is a daylight source; dark themes only want a whisper of it.
const ENV_INTENSITY_DARK = 0.2
const WIDTH = 64
const HEIGHT = 32

// Sky IBL bake parameters (prism's skyIbl preset): the sky is low-frequency
// content, so 256 px CubeUV with no pre-blur is plenty; the bake camera only
// needs to cover the unscaled unit-box dome (0.5 m from the camera).
const SKY_IBL_SIZE = 256
const SKY_IBL_SIGMA = 0
const SKY_IBL_NEAR = 0.1
const SKY_IBL_FAR = 100
const SKY_REBAKE_MS = 300

function buildGradientSky(): THREE.DataTexture {
  const data = new Float32Array(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++) {
    // Row 0 = v0 = nadir, top row = zenith (equirect v spans -90°..+90°).
    const lat = ((y + 0.5) / HEIGHT) * 2 - 1
    let r: number
    let g: number
    let b: number
    if (lat <= 0) {
      // Below the horizon: flat ground bounce, slightly darker toward nadir.
      const k = 1 + lat * 0.35
      r = GROUND[0] * k
      g = GROUND[1] * k
      b = GROUND[2] * k
    } else {
      // pow < 1 widens the warm horizon band.
      const t = lat ** 0.65
      r = HORIZON[0] + (ZENITH[0] - HORIZON[0]) * t
      g = HORIZON[1] + (ZENITH[1] - HORIZON[1]) * t
      b = HORIZON[2] + (ZENITH[2] - HORIZON[2]) * t
    }
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 1
    }
  }
  const texture = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat, THREE.FloatType)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.LinearSRGBColorSpace
  texture.needsUpdate = true
  return texture
}

export function SceneEnvironment() {
  const scene = useThree((state) => state.scene)
  const renderer = useThree((state) => state.gl)
  const invalidate = useThree((state) => state.invalidate)
  const gradientTexture = useMemo(buildGradientSky, [])
  const appearance = useViewer((state) => getSceneTheme(state.sceneTheme).appearance)
  const environmentMode = useViewer((state) => state.environmentMode)
  const hdriUrl = useViewer((state) => state.hdriUrl)
  const sunElevation = useViewer((state) => state.sunElevation)
  const sunAzimuth = useViewer((state) => state.sunAzimuth)
  const bakedSkyRtRef = useRef<THREE.RenderTarget | null>(null)

  const intensity = appearance === 'dark' ? ENV_INTENSITY_DARK : ENV_INTENSITY

  // The procedural-sky backdrop reads the shared uniforms directly, so sun
  // changes only need a uniform push + redraw — never a pipeline rebuild.
  useEffect(() => {
    skyUniforms.sunPosition.value.copy(sunDirection(sunElevation, sunAzimuth))
    invalidate()
  }, [sunElevation, sunAzimuth, invalidate])

  useEffect(() => {
    if (environmentMode === 'hdri') {
      let cancelled = false
      let loaded: THREE.Texture | null = null
      loadHdrTexture(hdriUrl)
        .then((texture) => {
          if (cancelled) {
            texture.dispose()
            return
          }
          loaded = texture
          scene.environment = texture
          scene.environmentIntensity = intensity
          setHdriBackdropTexture(texture)
          const image = texture.image as { width?: number; height?: number }
          console.log('[viewer/scene-environment] HDRI loaded', {
            hdriUrl,
            width: image.width,
            height: image.height,
          })
          // The post pipeline + horizon disc built their backdrop on the
          // gradient fallback — force the rebuild now that the texture exists.
          useViewer.getState().bumpEnvironmentVersion()
          invalidate()
        })
        .catch((error) => {
          console.warn(
            '[viewer/scene-environment] HDRI load failed; keeping the gradient backdrop.',
            {
              hdriUrl,
              error,
            },
          )
        })
      return () => {
        cancelled = true
        setHdriBackdropTexture(null)
        loaded?.dispose()
      }
    }

    if (environmentMode === 'sky') {
      const timer = setTimeout(() => {
        const bakeScene = new THREE.Scene()
        const bakeSky = new SkyMesh()
        bakeSky.sunPosition.value.copy(sunDirection(sunElevation, sunAzimuth))
        bakeSky.turbidity.value = skyUniforms.turbidity.value
        // The sun disc never goes into IBL: its energy is the directional
        // light's job, and a high-frequency disc aliases on low-res CubeUV.
        bakeSky.showSunDisc.value = 0
        bakeScene.add(bakeSky)
        const pmrem = new THREE.PMREMGenerator(renderer as unknown as THREE.WebGPURenderer)
        try {
          const renderTarget = pmrem.fromScene(
            bakeScene,
            SKY_IBL_SIGMA,
            SKY_IBL_NEAR,
            SKY_IBL_FAR,
            {
              size: SKY_IBL_SIZE,
            },
          )
          bakedSkyRtRef.current?.dispose()
          bakedSkyRtRef.current = renderTarget
          scene.environment = renderTarget.texture
          scene.environmentIntensity = intensity
          invalidate()
        } catch (error) {
          console.warn('[viewer/scene-environment] Sky IBL bake failed; IBL unchanged.', error)
        } finally {
          pmrem.dispose()
          bakeSky.geometry.dispose()
          bakeSky.material.dispose()
        }
      }, SKY_REBAKE_MS)
      return () => clearTimeout(timer)
    }

    // gradient
    scene.environment = gradientTexture
    scene.environmentIntensity = intensity
    invalidate()
    return undefined
  }, [
    scene,
    renderer,
    gradientTexture,
    intensity,
    environmentMode,
    hdriUrl,
    sunElevation,
    sunAzimuth,
    invalidate,
  ])

  // Final teardown: drop every GPU resource this component owns and leave the
  // scene without an environment map (a disposed texture must never linger).
  useEffect(
    () => () => {
      scene.environment = null
      setHdriBackdropTexture(null)
      bakedSkyRtRef.current?.dispose()
      gradientTexture.dispose()
    },
    [scene, gradientTexture],
  )

  return null
}
