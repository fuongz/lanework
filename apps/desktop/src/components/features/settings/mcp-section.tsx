import {
  Alert02Icon,
  McpServerIcon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  type AgentSetup,
  type McpServerAction,
  mcpActionRefusal,
  type SetupAgent,
  type SetupMcpServer,
  type SetupScope,
} from "#/../shared/agent-setup";
import type { Project } from "#/../shared/projects";
import logo from "#/components/shared/common/lanework-logo.png";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  SettingsCard,
  SettingsPage,
  type SettingsSectionSpec,
} from "#/components/shared/settings/settings-page";
import { SettingsScope } from "#/components/shared/settings/settings-scope";
import {
  SETUP_CHANGED,
  useAgentSetup,
} from "#/components/shared/settings/use-agent-setup";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Badge } from "#/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { ipcMessage } from "#/lib/ipc-error";
import { matches } from "#/lib/settings-catalog";
import { cn } from "#/lib/utils";
import { notify } from "#/stores/notify";
import {
  useSettingsProject,
  useSettingsProjectPick,
} from "#/stores/settings-project";
import { useSettingsSearch } from "#/stores/settings-search";

type Scope = "global" | "project";

/** A CLI's name, for the confirmation's sentence. */
const AGENT_NAMES: Record<SetupAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const AGENTS: { agent: SetupAgent; title: string }[] = [
  { agent: "claude", title: "Claude Code" },
  { agent: "codex", title: "Codex" },
  { agent: "opencode", title: "OpenCode" },
];

const SCOPES: Record<SetupScope, string> = {
  user: "User",
  project: "Project",
  local: "Local",
  plugin: "Plugin",
  system: "System",
};

/** Where each agent's servers come from, for its empty card. */
const FILES: Record<Scope, Record<SetupAgent, string>> = {
  global: {
    claude: "~/.claude.json",
    codex: "~/.codex/config.toml",
    opencode: "~/.config/opencode/opencode.json",
  },
  project: {
    claude: ".mcp.json or this project’s entry in ~/.claude.json",
    codex: ".codex/config.toml",
    opencode: "opencode.json",
  },
};

const PROJECT_SCOPES = new Set<SetupScope>(["project", "local"]);

/** How old a read may be before focusing the window reads again. */
const FOCUS_MIN_AGE_MS = 30_000;

/**
 * The agent setup every project gets, from the user's own config.
 *
 * Read on opening the page, and on window focus once the last read is half a
 * minute old, like {@link useAgentSetup}.
 */
function useGlobalSetup(): { setup: AgentSetup | null; error: string | null } {
  const [state, setState] = useState<{
    setup: AgentSetup | null;
    error: string | null;
  }>({ setup: null, error: null });

  useEffect(() => {
    const surface = window.desktop?.agentSetup;
    if (!surface) return;
    let gone = false;
    let readAt = 0;
    const read = () => {
      readAt = Date.now();
      surface.readGlobal().then(
        (setup) => !gone && setState({ setup, error: null }),
        (error: unknown) =>
          !gone &&
          // A read that failed keeps what the last one showed.
          setState((previous) => ({
            setup: previous.setup,
            error: ipcMessage(error, "Could not read your agent setup."),
          })),
      );
    };
    read();
    const onFocus = () => {
      if (Date.now() - readAt >= FOCUS_MIN_AGE_MS) read();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(SETUP_CHANGED, read);
    return () => {
      gone = true;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(SETUP_CHANGED, read);
    };
  }, []);

  return state;
}

/**
 * One server, drawn the way Projects › General's agent setup draws a row.
 *
 * Name, scope and the file it is in, with transport and target on the right.
 * Dimmed, with the reason under it, when the agent will not use it.
 */
function ServerRow({
  server,
  slug,
}: {
  server: SetupMcpServer;
  slug: string | null;
}) {
  const where = server.plugin ?? server.source;
  return (
    <div
      data-disabled={server.disabled ? "" : undefined}
      className={cn(
        "flex w-full items-start gap-4 px-4 py-3 text-left",
        // Lanework's own server, lit in the accent's tint (as the rail's
        // open row is), so it stands out from the agent's others.
        server.name === "lanework" && "bg-rail-active/60",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div
          className={cn(
            "flex min-w-0 items-center gap-2 overflow-hidden",
            server.disabled && "opacity-55",
          )}
        >
          {/* The name keeps its room and the file gives way, as in
              SetupRow: a config dir outside `~` is a long absolute path. */}
          {/* Lanework's own server carries its mark, so it reads as the
              app's rather than one more entry. */}
          {server.name === "lanework" && (
            <img src={logo} alt="" className="size-4 shrink-0 rounded-[4px]" />
          )}
          <span
            className="max-w-[65%] shrink-0 truncate text-sm font-medium"
            title={server.name}
          >
            {server.name}
          </span>
          <Badge variant="outline">{SCOPES[server.scope]}</Badge>
          <span
            className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
            title={server.source}
          >
            {where}
          </span>
        </div>
        {server.disabled && (
          <span
            data-testid="agent-setup-disabled"
            className="text-muted-foreground text-xs leading-relaxed"
          >
            {server.disabled}
          </span>
        )}
      </div>
      <span
        className={cn(
          "text-muted-foreground shrink-0 font-mono text-xs",
          server.disabled && "opacity-55",
        )}
      >
        {[server.transport, server.target].filter(Boolean).join(", ")}
      </span>
      <ServerActions server={server} slug={slug} />
    </div>
  );
}

/** Whether a server is off by a switch Lanework can turn back on. */
const switchedOff = (server: SetupMcpServer) =>
  server.disabled !== null &&
  (server.disabled.startsWith("Off:") ||
    server.disabled.startsWith("Turned off for this folder"));

/**
 * A row's … menu (FE-147): Disable or Enable where the CLI has a switch,
 * and Remove, asked first. Refused ones stay in the menu, dimmed, with why.
 */
function ServerActions({
  server,
  slug,
}: {
  server: SetupMcpServer;
  slug: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const off = switchedOff(server);
  const switchAction: McpServerAction = off ? "enable" : "disable";
  const switchRefusal = mcpActionRefusal(server, switchAction);
  const removeRefusal = mcpActionRefusal(server, "remove");
  // Lanework's own entry has its switch on the Harness page: no menu here.
  if (server.name === "lanework") return null;

  const run = async (action: McpServerAction) => {
    const surface = window.desktop?.agentSetup;
    if (!surface) return;
    setBusy(true);
    try {
      await surface.editMcp(slug, server.id, action);
      window.dispatchEvent(new Event(SETUP_CHANGED));
      notify(
        "success",
        action === "remove"
          ? `Removed ${server.name}`
          : `${action === "disable" ? "Turned off" : "Turned on"} ${server.name}`,
      );
    } catch (failure) {
      notify("error", `Could not change ${server.name}`, {
        description: ipcMessage(failure, "Its config file was left as it is."),
      });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`Actions for ${server.name}`}
              disabled={busy}
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] aria-expanded:bg-foreground/[0.06] -my-1 grid size-7 shrink-0 place-items-center rounded-md transition-colors"
            >
              <HugeiconsIcon
                icon={MoreHorizontalIcon}
                className="size-4"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-max min-w-36 max-w-72">
          <DropdownMenuItem
            disabled={switchRefusal !== null}
            onClick={() => void run(switchAction)}
            className="flex-col items-start gap-0.5"
          >
            {off ? "Enable" : "Disable"}
            {switchRefusal && (
              <span className="text-muted-foreground text-xs leading-snug">
                {switchRefusal}
              </span>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={removeRefusal !== null}
            onClick={() => setConfirming(true)}
            className="flex-col items-start gap-0.5"
          >
            Remove…
            {removeRefusal && (
              <span className="text-muted-foreground text-xs leading-snug">
                {removeRefusal}
              </span>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {server.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It is taken out of {server.source}; the rest of the file stays as
              it is. This cannot be undone here.
              {server.transport !== "stdio" &&
                (server.agent === "codex"
                  ? " Codex is signed out of it too."
                  : ` If ${AGENT_NAMES[server.agent]} signed in to it, its token stays in ${AGENT_NAMES[server.agent]}'s own store, unused.`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="border-0"
              disabled={busy}
              onClick={() => void run("remove")}
            >
              {busy ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A card of servers, narrowed to the ones the search names. */
function ServerCard({
  servers,
  empty,
  slug,
}: {
  servers: SetupMcpServer[];
  empty: string;
  slug: string | null;
}) {
  const query = useSettingsSearch((state) => state.query);
  const named = servers.filter((server) =>
    matches(query, server.name, server.target ?? undefined, server.source),
  );
  // The section matched on its title, not a server: show them all.
  const shown = named.length ? named : servers;
  return (
    <SettingsCard className="overflow-hidden">
      {shown.length === 0 ? (
        <Empty className="py-4">
          <EmptyHeader>
            <EmptyDescription>{empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        shown.map((server) => (
          <ServerRow key={server.id} server={server} slug={slug} />
        ))
      )}
    </SettingsCard>
  );
}

/** One section per agent, its server names the words search matches on. */
function agentSections(
  servers: SetupMcpServer[],
  scope: Scope,
  slug: string | null,
): SettingsSectionSpec[] {
  return AGENTS.map(({ agent, title }) => {
    const mine = servers.filter((server) => server.agent === agent);
    return {
      title,
      // The CLI's own mark before its name, as the Harness list has it.
      icon: <TerminalKindIcon kind={agent} className="size-4 shrink-0" />,
      keywords: [
        "mcp server",
        ...mine.map((server) => `${server.name} ${server.target ?? ""}`),
      ].join(" "),
      content: (
        <ServerCard
          servers={mine}
          empty={`No MCP servers in ${FILES[scope][agent]}`}
          slug={slug}
        />
      ),
    };
  });
}

/** What a read says around its servers: an error, files it could not read. */
function notices(
  setup: AgentSetup | null,
  error: string | null,
  reading: string,
): SettingsSectionSpec[] {
  const sections: SettingsSectionSpec[] = [];
  if (error)
    sections.push({
      title: "Error",
      hideTitle: true,
      content: (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      ),
    });
  if (setup && setup.unreadable.length > 0)
    sections.push({
      title: "Unreadable files",
      hideTitle: true,
      content: (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
          <AlertTitle>Some config files could not be read</AlertTitle>
          <AlertDescription className="font-mono">
            {setup.unreadable.join(", ")}
          </AlertDescription>
        </Alert>
      ),
    });
  if (!setup && !error)
    sections.push({
      title: "Reading",
      hideTitle: true,
      content: <ListSkeleton label={reading} rows={3} className="px-0" />,
    });
  return sections;
}

const DESCRIPTIONS: Record<Scope, string> = {
  global: "Servers every project gets. Dimmed ones are not in use.",
  project: "Servers only this project adds. Dimmed ones are not in use.",
};

/** The scope row of the MCP page: "All projects" or one of them. */
const SCOPE = <SettingsScope allowAll />;

function GlobalMcp() {
  const { setup, error } = useGlobalSetup();
  return (
    <SettingsPage
      scope={SCOPE}
      title="MCP"
      description={DESCRIPTIONS.global}
      sections={[
        ...notices(setup, error, "Reading your MCP servers…"),
        ...(setup ? agentSections(setup.mcp, "global", null) : []),
      ]}
    />
  );
}

function Nothing({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <SettingsCard>
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={McpServerIcon} strokeWidth={1.8} />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SettingsCard>
  );
}

function ProjectMcp({ project }: { project: Project }) {
  // Read again when the project's folder changes, like Projects › General.
  const { setup, error } = useAgentSetup(project.slug, [project.path ?? ""]);
  const mine = (setup?.mcp ?? []).filter((server) =>
    PROJECT_SCOPES.has(server.scope),
  );
  return (
    <SettingsPage
      scope={SCOPE}
      title="MCP"
      description={DESCRIPTIONS.project}
      sections={[
        ...notices(setup, error, `Reading ${project.name}’s MCP servers…`),
        ...(setup && !setup.folder
          ? [
              {
                title: "No folder",
                hideTitle: true,
                keywords: "mcp server folder",
                content: (
                  <Nothing
                    title="This project has no folder on this machine"
                    description="Link a folder to see its servers."
                  />
                ),
              },
            ]
          : []),
        ...(setup?.folder ? agentSections(mine, "project", project.slug) : []),
      ]}
    />
  );
}

/**
 * Settings › MCP: the MCP servers Claude Code and Codex load.
 *
 * One page with a scope row (FE-145): "All projects" shows the servers from
 * the user's own config, which every project gets; a project shows the ones
 * it adds on top. Read-only, like the rest of agent setup.
 */
export function McpSection() {
  const all = useSettingsProjectPick((state) => state.all);
  return all ? <GlobalMcp /> : <PickedProjectMcp />;
}

function PickedProjectMcp() {
  const project = useSettingsProject();
  if (!project)
    return (
      <SettingsPage
        scope={SCOPE}
        title="MCP"
        description={DESCRIPTIONS.project}
        sections={[
          {
            title: "No project",
            hideTitle: true,
            content: (
              <Nothing
                title="No projects yet"
                description="Add a project to see its servers."
              />
            ),
          },
        ]}
      />
    );
  // Keyed by slug: picking another project starts from an empty read.
  return <ProjectMcp key={project.slug} project={project} />;
}
