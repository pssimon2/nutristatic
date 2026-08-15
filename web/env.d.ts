// Vite asset-import modules used by the worker (kernel.wasm?url).
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
