// Vite asset-import modules used by the worker (kernel2.wasm?url).
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
