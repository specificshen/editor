/**
 * Types for the vendored draco encoder glue (see
 * packages/editor/scripts/vendor-draco-encoder.mjs). The encoder wasm is served
 * by the host app from public/draco/ and fetched at runtime via locateFile().
 */
export interface DracoEncoderModuleOptions {
  locateFile?: (file: string) => string
}

declare function createEncoderModule(options?: DracoEncoderModuleOptions): Promise<unknown>

export default createEncoderModule
