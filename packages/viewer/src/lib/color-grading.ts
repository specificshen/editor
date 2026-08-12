import { float, luminance, saturation, vec3 } from 'three/tsl'

/** Scene-referred color grading, applied before the output tone mapping. All
 * fields are deltas: 0 leaves the image unchanged. UI clamps to [-1, 1]. */
export type ColorGrading = {
  /** Contrast around a mid-gray pivot, so overall exposure doesn't drift. */
  contrast: number
  /** Saturation offset; -1 desaturates to grayscale. */
  saturation: number
  /** Warm/cool shift: positive warms (more red, less blue). */
  whiteBalance: number
  /** Additive lift on the highlight region (luminance above the midpoint). */
  highlights: number
  /** Additive lift on the shadow region (luminance below the midpoint). */
  shadows: number
}

/** Approximates the viewer's previous fixed pow-curve grade (contrast 1.05,
 * saturation 1.1) with the linear operators below. */
export const DEFAULT_GRADING: ColorGrading = {
  contrast: 0.05,
  saturation: 0.1,
  whiteBalance: 0,
  highlights: 0,
  shadows: 0,
}

export function isGradingIdentity(grading: ColorGrading): boolean {
  return (
    grading.contrast === 0 &&
    grading.saturation === 0 &&
    grading.whiteBalance === 0 &&
    grading.highlights === 0 &&
    grading.shadows === 0
  )
}

const CONTRAST_PIVOT = 0.18
const WHITE_BALANCE_SCALE = 0.12
const HIGHLIGHT_GAIN = 0.25
const SHADOW_GAIN = 0.18
const LUMA_MIDPOINT = 0.5

// Each field accepts a plain number (baked into the shader) or a TSL node
// (uniform — live-adjustable without rebuilding the pipeline).
type GradingParams = {
  [K in keyof ColorGrading]: any
}

const asFloat = (value: any) => (typeof value === 'number' ? float(value) : value)

/** Saturation → contrast → white balance → highlight/shadow split. Ported
 * from prism-studio's post pipeline, keeping its tuned gain constants. */
export function applyColorGrading(rgb: any, grading: GradingParams) {
  const contrast = asFloat(grading.contrast)
  const saturationDelta = asFloat(grading.saturation)
  const whiteBalance = asFloat(grading.whiteBalance)
  const highlights = asFloat(grading.highlights)
  const shadows = asFloat(grading.shadows)

  let graded = saturation(rgb, saturationDelta.add(1))
  graded = graded.sub(CONTRAST_PIVOT).mul(contrast.add(1)).add(CONTRAST_PIVOT)

  const temperature = whiteBalance.mul(WHITE_BALANCE_SCALE)
  graded = graded.mul(vec3(temperature.add(1), 1, temperature.oneMinus()))

  const luma = luminance(graded)
  const highlightMask = luma.sub(LUMA_MIDPOINT).mul(2).clamp(0, 1)
  const shadowMask = luma.mul(-2).add(1).clamp(0, 1)
  return graded
    .add(highlightMask.mul(highlights.mul(HIGHLIGHT_GAIN)))
    .add(shadowMask.mul(shadows.mul(SHADOW_GAIN)))
    .max(0)
}
