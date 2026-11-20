declare module "virtual:worker-code" {
  /** The bundled worker source, inlined at build time and started from a Blob URL. */
  const code: string;
  export default code;
}
