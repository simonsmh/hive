// This package compiles without the DOM lib, and BufferSource is the one ambient
// WebCrypto name the sources reference (in type casts inside webpush.ts). Deno
// provides its own global BufferSource when checking the Edge Function copies —
// this declaration exists only for this package's Node typecheck and is not copied.
type BufferSource = ArrayBufferView | ArrayBuffer;
