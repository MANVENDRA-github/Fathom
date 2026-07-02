/** Minimal WebGPU capability probe (M0). Portfolio's useSyncExternalStore gate is lifted in a later pass. */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}
