/** Minimal WebGPU capability probe (M0). Portfolio's useSyncExternalStore gate is lifted in a later pass. */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/** Shared user-facing copy for the adapter-null case (browser has `navigator.gpu` but grants no GPU). */
export const NO_ADAPTER_MSG =
  'Your browser reports WebGPU, but no GPU adapter was granted — this happens over remote desktop, ' +
  'in VMs, or on blocklisted drivers. Try Chrome/Edge 113+ on hardware with a GPU.';
