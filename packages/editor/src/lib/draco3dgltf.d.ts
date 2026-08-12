/**
 * draco3dgltf ships no type declarations; this is the minimal surface we use.
 * The encoder wasm is served by the host app from public/draco/ and loaded at
 * runtime by URL. Ported from prism-studio (MIT, Samuel Ouyang).
 */
declare module 'draco3dgltf' {
  export interface DracoModuleFactoryOptions {
    locateFile?: (file: string) => string
  }

  const draco3dgltf: {
    createEncoderModule(options?: DracoModuleFactoryOptions): Promise<unknown>
    createDecoderModule(options?: DracoModuleFactoryOptions): Promise<unknown>
  }
  export default draco3dgltf
}
