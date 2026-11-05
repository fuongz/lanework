// The CLI flags that point one agent process at the local board server
// (FE-121/D9). Pure, so the engines and their tests use them without main.
//
// Which conversations need them is `mcp-binding.ts`.

/** Claude Code's `--mcp-config` for the local server: it replaces `lanework`. */
export function claudeMcpArgs(shim: string): string[] {
  return [
    "--mcp-config",
    JSON.stringify({
      mcpServers: { lanework: { type: "stdio", command: shim, args: [] } },
    }),
  ];
}

/**
 * Codex's `-c` overrides for the local server.
 *
 * NOTE: Codex MERGES an override into the configured table, and refuses a
 * `lanework` with both the cloud `url` and a `command`. So the cloud entry is
 * switched off for this process and the local one runs beside it as
 * `lanework_local`. Switching off an entry that is not there is refused
 * too, so that override is sent only when the config has one.
 */
export function codexMcpArgs(shim: string, configured: boolean): string[] {
  return [
    ...(configured ? ["-c", "mcp_servers.lanework.enabled=false"] : []),
    "-c",
    `mcp_servers.lanework_local={command=${JSON.stringify(shim)},args=[]}`,
  ];
}
