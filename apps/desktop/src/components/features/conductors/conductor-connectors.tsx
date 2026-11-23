// The Connectors page of the conductor dialog (FE-166): the MCP servers its
// agent can reach from this project, one switch each. The list is a
// DENYLIST on the conductor (`connectors.disabled`): by default it gets every
// connector, and a switch turned off adds its name.
//
// Laid out as a plugin directory: a tab per kind (Claude.ai, Plugins, MCPs)
// with its count, a search, and one row per connector with its mark, name,
// what it is, and its switch. Lanework's own servers are not listed.
//
// NOTE: Opening the page reads only the cached inventory. The account scan
// behind Refresh is slow and may touch the network, so it runs on a press and
// never on its own; main sends no change event for connectors.

import {
  Alert02Icon,
  Calendar03Icon,
  Database01Icon,
  DropboxIcon,
  FigmaIcon,
  GithubIcon,
  GoogleDocIcon,
  GoogleDriveIcon,
  Loading03Icon,
  Mail01Icon,
  McpServerIcon,
  NotionIcon,
  Refresh01Icon,
  Search01Icon,
  SlackIcon,
  StripeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Connector,
  ConnectorAgent,
  ConnectorInventory,
  ConnectorSource,
} from "#/../shared/connectors";
import { AGENT_LABELS } from "#/../shared/conversation";
import type { TeamLeadInput } from "#/../shared/orchestration";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Switch } from "#/components/ui/switch";
import {
  type ConnectorRow,
  connectorGroups,
  switchable,
  withConnector,
  withConnectors,
} from "#/lib/connectors";
import { ipcMessage } from "#/lib/ipc-error";
import { relativeTime } from "#/lib/relative-time";
import { cn } from "#/lib/utils";

/** The page's tabs, each a set of sources, in the order drawn. */
const TABS = [
  { key: "account", label: "Claude.ai", sources: ["claude-ai"] },
  { key: "plugins", label: "Plugins", sources: ["plugin"] },
  { key: "mcps", label: "MCPs", sources: ["user", "project", "local"] },
] as const satisfies readonly {
  key: string;
  label: string;
  sources: readonly ConnectorSource[];
}[];
type TabKey = (typeof TABS)[number]["key"];

/** Where a server in the MCPs tab is set up, in words. */
const MCP_ORIGIN: Partial<Record<ConnectorSource, string>> = {
  user: "your config",
  project: "this project's .mcp.json",
  local: "your local config",
};

/** A name's known service, matched on a word in it, and its mark. */
const MARKS: [pattern: RegExp, icon: typeof McpServerIcon][] = [
  [/figma/i, FigmaIcon],
  [/github/i, GithubIcon],
  [/gmail|mail/i, Mail01Icon],
  [/drive/i, GoogleDriveIcon],
  [/docs?\b/i, GoogleDocIcon],
  [/calendar/i, Calendar03Icon],
  [/slack/i, SlackIcon],
  [/notion/i, NotionIcon],
  [/stripe/i, StripeIcon],
  [/dropbox/i, DropboxIcon],
  [/data(base)?\b|sql|postgres|supabase/i, Database01Icon],
];

function markOf(name: string): typeof McpServerIcon {
  return MARKS.find(([pattern]) => pattern.test(name))?.[1] ?? McpServerIcon;
}

/**
 * The name as a person reads it: a claude.ai connector without its
 * `claude.ai ` prefix (the tab says so), a plugin's server without
 * `plugin:<plugin>:`.
 */
function displayName(connector: Connector): string {
  const { name } = connector;
  if (connector.source === "claude-ai")
    return name.replace(/^claude\.ai\s+/i, "");
  const plugin = /^plugin:[^:]+:(.+)$/.exec(name);
  return plugin ? plugin[1] : name;
}

const TRANSPORT_WORDS: Record<NonNullable<Connector["transport"]>, string> = {
  http: "a remote server",
  sse: "a remote server (SSE)",
  stdio: "a local command",
};

/** The line under a connector's name: what holds it back, or what it is. */
function describe(row: ConnectorRow): string {
  const { connector, state } = row;
  if (state.kind === "unavailable") return state.reason;
  if (connector.auth === "needs-auth")
    return "Needs sign-in. Connect it in the agent's own harness (its /mcp or mcp login), then Refresh.";
  const what = connector.transport
    ? TRANSPORT_WORDS[connector.transport]
    : "an MCP server";
  if (connector.source === "claude-ai")
    return `Connected to your Claude.ai account, through ${what}`;
  if (connector.source === "plugin") {
    const plugin = /^plugin:([^:]+):/.exec(connector.name)?.[1];
    return plugin
      ? `From the ${plugin} plugin, through ${what}`
      : `From a plugin, through ${what}`;
  }
  const origin = MCP_ORIGIN[connector.source];
  return origin ? `Set up in ${origin}, as ${what}` : `As ${what}`;
}

/** When the inventory was last scanned, in words. */
function scanned(inventory: ConnectorInventory, now: number): string {
  const at = inventory.accountScannedAt ?? inventory.scannedAt;
  const words = relativeTime(at, now);
  if (inventory.agent === "claude" && !inventory.accountScannedAt)
    return "Account connectors not scanned yet";
  return words ? `Last scanned ${words}` : "Not scanned yet";
}

/** One connector: its mark, its name and what it is, and its switch. */
const ConnectorLine = memo(function ConnectorLine({
  row,
  onToggle,
}: {
  row: ConnectorRow;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  const { connector, state } = row;
  const unavailable = state.kind === "unavailable";
  const name = displayName(connector);
  return (
    <li
      className={cn(
        "flex items-center gap-4 py-3.5",
        unavailable && "opacity-60",
      )}
    >
      <span className="bg-card grid size-10 shrink-0 place-items-center rounded-xl border">
        <HugeiconsIcon
          icon={markOf(name)}
          className="size-5"
          strokeWidth={1.6}
          aria-hidden="true"
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium">{name}</span>
        <span className="text-muted-foreground text-[13px] leading-snug">
          {describe(row)}
        </span>
      </span>
      <Switch
        aria-label={`${name} for this conductor`}
        checked={state.kind === "on"}
        disabled={unavailable}
        onCheckedChange={(checked) => onToggle(connector.name, checked)}
      />
    </li>
  );
});

/**
 * The Connectors page: the inventory of `agent` in `project`, a tab per kind,
 * with a switch per connector.
 *
 * `disabled` is the draft's `connectors.disabled`; `onChange` hands back the
 * whole `connectors` value (undefined when none is disabled).
 */
export function ConductorConnectors({
  project,
  agent,
  disabled,
  onChange,
}: {
  project: string;
  agent: ConnectorAgent;
  disabled: readonly string[];
  onChange: (connectors: TeamLeadInput["connectors"]) => void;
}) {
  const [inventory, setInventory] = useState<ConnectorInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  /** The tab chosen by hand; null follows the first one with any rows. */
  const [picked, setPicked] = useState<TabKey | null>(null);

  // The cached inventory, once per project and agent. NOT refresh.
  useEffect(() => {
    setInventory(null);
    setError(null);
    const surface = window.desktop?.connectors;
    if (!surface) {
      setError("This window is not connected to the desktop app.");
      return;
    }
    let gone = false;
    surface.inventory(project, agent).then(
      (next) => !gone && setInventory(next),
      (failure: unknown) =>
        !gone &&
        setError(ipcMessage(failure, "Could not read the connectors.")),
    );
    return () => {
      gone = true;
    };
  }, [project, agent]);

  const refresh = useCallback(async () => {
    const surface = window.desktop?.connectors;
    if (!surface) return;
    setRefreshing(true);
    try {
      setInventory(await surface.refresh(project, agent));
      setError(null);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not scan the connectors."));
    } finally {
      setRefreshing(false);
    }
  }, [project, agent]);

  // The latest value behind a stable handler, so a switch redraws its own
  // row and not the whole list.
  const latest = useRef({ disabled, onChange });
  latest.current = { disabled, onChange };
  const toggle = useCallback((name: string, enabled: boolean) => {
    const { disabled: current, onChange: change } = latest.current;
    change(withConnector(current, name, enabled));
  }, []);
  const toggleMany = useCallback((names: string[], enabled: boolean) => {
    const { disabled: current, onChange: change } = latest.current;
    change(withConnectors(current, names, enabled));
  }, []);

  const disabledSet = useMemo(() => new Set(disabled), [disabled]);
  /** Every listed row of each tab, in source order then by name. */
  const tabs = useMemo(() => {
    const groups = inventory
      ? connectorGroups(inventory, agent, disabledSet)
      : [];
    return TABS.map((tab) => ({
      ...tab,
      rows: groups
        .filter((group) =>
          (tab.sources as readonly ConnectorSource[]).includes(group.source),
        )
        .flatMap((group) => group.rows),
    }));
  }, [inventory, agent, disabledSet]);
  const active =
    tabs.find((tab) => tab.key === picked && tab.rows.length > 0) ??
    tabs.find((tab) => tab.rows.length > 0) ??
    tabs[0];

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      q
        ? active.rows.filter((row) =>
            displayName(row.connector).toLowerCase().includes(q),
          )
        : active.rows,
    [active.rows, q],
  );
  // "Disable all" while any of this tab's is on; once all are off, "Enable".
  const changeable = useMemo(() => switchable(active.rows), [active.rows]);
  const anyOn = changeable.some((row) => row.state.kind === "on");
  const onCount = active.rows.filter((row) => row.state.kind === "on").length;
  const stamp = useMemo(
    // Read once per inventory: the line is never redrawn on a timer.
    () => (inventory ? scanned(inventory, Date.now()) : null),
    [inventory],
  );
  const empty =
    inventory !== null && tabs.every((tab) => tab.rows.length === 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b py-3 pr-12 pl-5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-sm font-medium">Connectors</h2>
          <span className="text-muted-foreground truncate text-xs">
            What {AGENT_LABELS[agent]} can reach from this project. Off means
            this conductor is told not to use it.
          </span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-5 pb-6">
        {/* Tabs with their counts, and the search. */}
        <div className="flex shrink-0 items-center gap-3">
          <div
            role="tablist"
            aria-label="Kinds of connector"
            className="flex gap-1"
          >
            {tabs.map((tab) => {
              const selected = tab.key === active.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  disabled={tab.rows.length === 0}
                  onClick={() => setPicked(tab.key)}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] transition-colors disabled:opacity-40",
                    selected
                      ? "bg-foreground/[0.06] text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                  <span className="tabular-nums opacity-70">
                    {tab.rows.length}
                  </span>
                </button>
              );
            })}
          </div>
          <label className="focus-within:border-ring ml-auto flex h-8 w-56 min-w-0 items-center gap-2 rounded-lg border px-2.5">
            <HugeiconsIcon
              icon={Search01Icon}
              className="text-muted-foreground size-4 shrink-0"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search connectors"
              aria-label="Search connectors"
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            />
          </label>
        </div>
        {/* This tab's tally, every one of it at once, and the account scan. */}
        <div className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate" aria-live="polite">
            {inventory && !empty
              ? `${onCount} of ${active.rows.length} on`
              : null}
            {stamp && (
              <span className={inventory && !empty ? "ml-3" : undefined}>
                {stamp}
              </span>
            )}
          </span>
          {changeable.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                toggleMany(
                  changeable.map((row) => row.connector.name),
                  !anyOn,
                )
              }
              className="text-muted-foreground h-7 shrink-0 rounded-lg px-2 text-[12px]"
            >
              {anyOn ? "Disable all" : "Enable all"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={refreshing || !inventory}
            onClick={() => void refresh()}
            className="h-7 shrink-0 gap-1 rounded-lg px-2 text-[12px]"
          >
            <HugeiconsIcon
              icon={refreshing ? Loading03Icon : Refresh01Icon}
              strokeWidth={1.8}
              data-icon="inline-start"
              aria-hidden="true"
              className={
                refreshing
                  ? "animate-spin motion-reduce:animate-none"
                  : undefined
              }
            />
            {refreshing ? "Scanning" : "Refresh"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        {inventory?.error && (
          <Alert>
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
            <AlertDescription>{inventory.error}</AlertDescription>
          </Alert>
        )}
        {!inventory && !error && (
          <ListSkeleton
            label="Reading the connectors"
            rows={5}
            className="px-0"
          />
        )}
        {inventory &&
          (empty || rows.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                {!q && (
                  <EmptyMedia variant="icon">
                    <HugeiconsIcon icon={McpServerIcon} strokeWidth={1.8} />
                  </EmptyMedia>
                )}
                <EmptyTitle>
                  {q ? "No matches" : "No connectors found"}
                </EmptyTitle>
                <EmptyDescription>
                  {q
                    ? `No connector matches “${query.trim()}”.`
                    : `${AGENT_LABELS[agent]} has no MCP servers for this project. Add one in its own config, then Refresh.`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul
              role="tabpanel"
              aria-label={active.label}
              className="divide-border shrink-0 divide-y"
            >
              {rows.map((row) => (
                <ConnectorLine
                  key={`${row.connector.source}:${row.connector.name}`}
                  row={row}
                  onToggle={toggle}
                />
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}
