/**
 * Ambient declaration for Vite's `?url` asset-import convention (the same
 * shape `vite/client` ships), needed because this package is typechecked/built
 * by plain `tsc` — not Vite — even though its output only ever runs inside the
 * Vite-bundled overlay renderer. See index.ts's onnxruntime-web wasm imports.
 */
declare module '*?url' {
  const url: string;
  export default url;
}
