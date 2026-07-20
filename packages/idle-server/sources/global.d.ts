// WebAssembly types for Node.js (not included in lib without "dom")
// Used by PGlite WASM loading in storage/db.ts and storage/pgliteLoader.ts
declare namespace WebAssembly {
    class Module {
        constructor(bytes: BufferSource);
    }
}
