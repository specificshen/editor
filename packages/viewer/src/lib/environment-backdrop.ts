import { equirectUV, texture } from 'three/tsl'
import { backdropGradient } from './backdrop'
import { getHdriBackdropTexture } from './hdri'
import { proceduralSky } from './procedural-sky'

/**
 * The visible environment backdrop. `scene.background` is deliberately never
 * set — the post pipeline's alpha-based geometry mask depends on background
 * pixels reading the far plane, which a background mesh would overwrite — so
 * the backdrop is composited per pixel from the world-space view direction.
 * One formula feeds all three consumers (post pipeline backdrop, site
 * horizon-disc dissolve, snapshot pipeline), which is what keeps ground and
 * sky meeting without a seam from any camera pose.
 *
 * Modes:
 * - `gradient`: the theme sky gradient (lib/backdrop.ts) — always available.
 * - `sky`: the procedural Preetham sky (lib/procedural-sky.ts), sun driven by
 *   the shared skyUniforms so uniform tweaks never rebuild the pipeline.
 * - `hdri`: the loaded HDR/EXR texture sampled equirectangularly. Until the
 *   texture arrives (or if the load failed) falls back to the gradient.
 */
export type EnvironmentMode = 'gradient' | 'hdri' | 'sky'

export function environmentBackdropNode({
  mode,
  dir,
  gradient,
}: {
  mode: EnvironmentMode
  /** Normalized world-space view direction (horizon = dir.y 0). */
  dir: any
  gradient: { background: any; haze: any; sky: any; skyDeep: any }
}): any {
  if (mode === 'hdri') {
    const hdriTexture = getHdriBackdropTexture()
    if (hdriTexture) {
      return texture(hdriTexture, equirectUV(dir)).rgb
    }
  } else if (mode === 'sky') {
    return proceduralSky(dir)
  }
  return backdropGradient({
    dirY: dir.y,
    background: gradient.background,
    haze: gradient.haze,
    sky: gradient.sky,
    skyDeep: gradient.skyDeep,
  })
}
