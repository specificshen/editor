import {
  acos,
  add,
  clamp,
  cos,
  dot,
  exp,
  float,
  max,
  mix,
  normalize,
  pow,
  smoothstep,
  sub,
  uniform,
  vec3,
} from 'three/tsl'
import { Vector3 } from 'three/webgpu'

/**
 * Sun-direction convention: azimuth 0° = north (world -Z, matching glTF
 * forward), increasing clockwise (90° = east, +X); elevation is the angle
 * above the horizon. Same convention as prism's environment contract.
 */
export function sunDirection(elevationDeg: number, azimuthDeg: number): Vector3 {
  const elevation = (elevationDeg * Math.PI) / 180
  const azimuth = (azimuthDeg * Math.PI) / 180
  const cosElevation = Math.cos(elevation)
  return new Vector3(
    Math.sin(azimuth) * cosElevation,
    Math.sin(elevation),
    -Math.cos(azimuth) * cosElevation,
  )
}

/**
 * Shared procedural-sky uniforms. Singleton so the visible backdrop (post
 * pipeline + horizon disc, which evaluate `proceduralSky` per fragment) and
 * the PMREM bake in scene-environment all read the same sun. `sunPosition`
 * must never be the zero vector — the shader normalizes it.
 */
export const skyUniforms = {
  sunPosition: uniform(sunDirection(40, 45)),
  turbidity: uniform(2),
  rayleigh: uniform(1),
  mieCoefficient: uniform(0.005),
  mieDirectionalG: uniform(0.8),
  showSunDisc: uniform(1),
}

const UP = vec3(0, 1, 0)

/**
 * Preetham daylight model, ported from three r185's SkyMesh (examples/jsm/
 * objects/SkyMesh.js) as a pure function of view direction. SkyMesh's own
 * colorNode is bound to vertex varyings + positionWorld, neither of which
 * exists in the post pipeline's fullscreen pass — but those varyings are pure
 * functions of the uniforms, so the whole chain inlines here. Clouds are
 * dropped; the sun disc stays (bloom feeds on it).
 */
export function proceduralSky(dir: any): any {
  // --- vertex-stage derivatives in SkyMesh (uniform-only, so per-fragment
  // evaluation is identical) ---
  const e = float(Math.E)
  const totalRayleigh = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5)
  const MieConst = vec3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14)
  const cutoffAngle = float(1.6110731556870734)
  const steepness = float(1.5)
  const EE = float(1000.0)

  const sunDir = normalize(skyUniforms.sunPosition)

  const angle = dot(sunDir, UP)
  const zenithAngleCos = clamp(angle, -1, 1)
  const vSunE = EE.mul(
    max(0.0, float(1.0).sub(pow(e, cutoffAngle.sub(acos(zenithAngleCos)).div(steepness).negate()))),
  )

  // Sun fade reads the raw (un-normalized) sun position, as in SkyMesh.
  const sunfade = float(1.0).sub(
    clamp(float(1.0).sub(exp(skyUniforms.sunPosition.y.div(450000.0))), 0, 1),
  )
  const rayleighCoefficient = skyUniforms.rayleigh.sub(float(1.0).mul(float(1.0).sub(sunfade)))
  const vBetaR = totalRayleigh.mul(rayleighCoefficient)
  const c = float(0.2).mul(skyUniforms.turbidity).mul(10e-18)
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: exact SkyMesh port — 0.434 (not Math.LOG10E) is what the shader uses.
  const totalMie = float(0.434).mul(c).mul(MieConst)
  const vBetaM = totalMie.mul(skyUniforms.mieCoefficient)

  // --- fragment stage ---
  const pi = float(Math.PI)
  const rayleighZenithLength = float(8.4e3)
  const mieZenithLength = float(1.25e3)
  const sunAngularDiameterCos = float(0.9999566769464484)
  const THREE_OVER_SIXTEENPI = float(0.05968310365946075)
  const ONE_OVER_FOURPI = float(0.07957747154594767)

  const direction = normalize(dir)

  // Optical length (cutoff at 90° avoids the singularity).
  const zenithAngle = acos(max(0.0, dot(UP, direction)))
  const inverse = float(1.0).div(
    cos(zenithAngle).add(
      float(0.15).mul(pow(float(93.885).sub(zenithAngle.mul(180.0).div(pi)), -1.253)),
    ),
  )
  const sR = rayleighZenithLength.mul(inverse)
  const sM = mieZenithLength.mul(inverse)

  // Combined extinction factor.
  // (cast) three's TSL types declare exp() float-only; the runtime math node
  // is component-wise and SkyMesh relies on exactly that for vec3.
  const Fex = exp(vBetaR.mul(sR).add(vBetaM.mul(sM)).negate() as any)

  // In scattering.
  const cosTheta = dot(direction, sunDir)
  const cTheta = cosTheta.mul(0.5).add(0.5)
  const rPhase = THREE_OVER_SIXTEENPI.mul(float(1.0).add(pow(cTheta, 2.0)))
  const betaRTheta = vBetaR.mul(rPhase)
  const g2 = pow(skyUniforms.mieDirectionalG, 2.0)
  const inv = float(1.0).div(
    pow(float(1.0).sub(float(2.0).mul(skyUniforms.mieDirectionalG).mul(cosTheta)).add(g2), 1.5),
  )
  const mPhase = ONE_OVER_FOURPI.mul(float(1.0).sub(g2)).mul(inv)
  const betaMTheta = vBetaM.mul(mPhase)

  const scatter = vSunE.mul(add(betaRTheta, betaMTheta).div(add(vBetaR, vBetaM)))
  // SkyMesh writes these as mulAssign/addAssign chains; assigns need a Fn()
  // stack, which a plain helper doesn't have — compose new nodes instead.
  const Lin = scatter
    .mul(sub(1.0, Fex))
    .pow(vec3(1.5))
    .mul(
      mix(
        vec3(1.0),
        scatter.mul(Fex).pow(vec3(1.0 / 2.0)),
        clamp(pow(sub(1.0, dot(UP, sunDir)), 5.0), 0.0, 1.0),
      ),
    )

  // Nightsky + solar disc.
  const sundisc = smoothstep(
    sunAngularDiameterCos,
    sunAngularDiameterCos.add(0.00002),
    cosTheta,
  ).mul(skyUniforms.showSunDisc)
  const L0 = vec3(0.1).mul(Fex).add(vSunE.mul(19000.0).mul(Fex).mul(sundisc))

  return add(Lin, L0)
    .mul(0.04)
    .add(vec3(0.0, 0.0003, 0.00075))
}
