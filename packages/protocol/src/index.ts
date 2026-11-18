// @lanework/protocol: the HTTP contract between the Lanework desktop app (and
// its checkpoint hook) and the Lanework API (MIT).
//
// NOTE: Types, path builders and the tool contract (`./tools`: data plus a
// pure JSON Schema builder) only. Nothing here may import from `apps/` or
// `packages/db`: this package ships with the open-source desktop, and the
// server that implements it does not. When a route or a tool changes shape,
// change it here in the same commit.

export * from "./agent-notes";
export * from "./auth";
export * from "./boards";
export * from "./checkpoints";
export * from "./common";
export * from "./endpoints";
export * from "./sync";
export * from "./tools/index";
