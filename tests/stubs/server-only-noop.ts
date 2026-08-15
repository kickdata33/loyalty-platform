// Test-only stub for the "server-only" package (see vitest.config.mts `resolve.alias`).
//
// The real `server-only` package intentionally throws unless imported under Next.js's
// "react-server" bundling condition — which protects `src/lib/firebase/admin.ts` from being
// accidentally imported into a Client Component in the actual Next.js app, but also makes it
// unimportable from plain Node tooling like Vitest. Vitest tests always run in a server-side
// Node process (never a browser bundle), so the guard's purpose doesn't apply here — this empty
// module lets tests import admin.ts without disabling the real guard for the Next.js build.
export {};
