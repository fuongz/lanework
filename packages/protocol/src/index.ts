// @lanework/protocol — the HTTP contract between the Lanework desktop app /
// checkpoint hook and the Lanework API (MIT).
//
// ⚠️ Types and path builders only. Nothing here may import from `apps/` or
// `packages/db`: this package ships with the open-source desktop, and the
// server that implements it does not. When a route changes shape, change it
// here in the same commit.

export * from "./auth";
export * from "./boards";
export * from "./checkpoints";
export * from "./common";
export * from "./endpoints";
export * from "./sync";
