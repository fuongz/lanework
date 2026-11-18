// The tool contract (FE-152): every tool an agent can call on Lanework, by
// name, description, read-only flag, input schema and answer type. The board
// MCP servers (cloud and offline) serve `BOARD_TOOLS`; lanework-kit (the
// `lwk` CLI and its MCP server) serves `KIT_TOOLS`.
//
// NOTE: `apps/desktop/scripts/mcp-parity.mjs` checks the offline board server
// against this file in `bun run gate`. Descriptions are literals: they sit in
// an agent's cached prompt prefix.
import {
  BOARD_TOOLS,
  type BoardToolName,
  type BoardToolOutputs,
} from "./board";
import {
  KIT_TOOLS,
  type KitToolInputs,
  type KitToolName,
  type KitToolOutputs,
} from "./kit";
import type { ToolContract } from "./schema";

export * from "./board";
export * from "./kit";
export * from "./schema";

export type ToolName = BoardToolName | KitToolName;

/** What any tool answers, by name. */
export type ToolOutputs = BoardToolOutputs & KitToolOutputs;
export type ToolOutput<Name extends ToolName> = ToolOutputs[Name];
export type KitToolInput<Name extends KitToolName> = KitToolInputs[Name];

/** One tool's contract by name, board or kit; undefined when there is none. */
export function toolContract(name: string): ToolContract<ToolName> | undefined {
  return (
    BOARD_TOOLS.find((tool) => tool.name === name) ??
    KIT_TOOLS.find((tool) => tool.name === name)
  );
}
