import { Alert02Icon, McpServerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import type {
  AgentSetup,
  SetupAgent,
  SetupMcpServer,
  SetupScope,
} from "#/../shared/agent-setup";
import type { Workspace } from "#/../shared/workspaces";
import { ListSkeleton } from "#/components/shared/loading/skeletons";
import {
  SettingsCard,
  SettingsPage,
  type SettingsSectionSpec,
} from "#/components/shared/settings/settings-page";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
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
import { useSettingsProject } from "#/stores/settings-project";
import { useSettingsSearch } from "#/stores/settings-search";
import { useAgentSetup } from "./use-agent-setup";

type Scope = "global" | "project";

const AGENTS: { agent: SetupAgent; title: string }[] = [
  { agent: "claude", title: "Claude Code" },
  { agent: "codex", title: "Codex" },
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
  global: { claude: "~/.claude.json", codex: "~/.codex/config.toml" },
  project: {
    claude: ".mcp.json or this project’s entry in ~/.claude.json",
    codex: ".codex/config.toml",
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
    return () => {
      gone = true;
      window.removeEventListener("focus", onFocus);
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
function ServerRow({ server }: { server: SetupMcpServer }) {
  const where = server.plugin ?? server.source;
  return (
    <div
      data-disabled={server.disabled ? "" : undefined}
      className="flex w-full items-start gap-4 px-4 py-3 text-left"
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
    </div>
  );
}

/** A card of servers, narrowed to the ones the search names. */
function ServerCard({
  servers,
  empty,
}: {
  servers: SetupMcpServer[];
  empty: string;
}) {
  const query = useSettingsSearch((state) => state.query);
  const named = servers.filter((server) =>
    matches(query, server.name, server.target ?? undefined, server.source),
  );
  // The section matched on its title, not a server: show them all.
  const shown = named.length ? named : servers;
  return (
    <SettingsCard>
      {shown.length === 0 ? (
        <Empty className="py-4">
          <EmptyHeader>
            <EmptyDescription>{empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        shown.map((server) => <ServerRow key={server.id} server={server} />)
      )}
    </SettingsCard>
  );
}

/** One section per agent, its server names the words search matches on. */
function agentSections(
  servers: SetupMcpServer[],
  scope: Scope,
): SettingsSectionSpec[] {
  return AGENTS.map(({ agent, title }) => {
    const mine = servers.filter((server) => server.agent === agent);
    return {
      title,
      keywords: [
        "mcp server",
        ...mine.map((server) => `${server.name} ${server.target ?? ""}`),
      ].join(" "),
      content: (
        <ServerCard
          servers={mine}
          empty={`No MCP servers in ${FILES[scope][agent]}`}
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

function GlobalMcp() {
  const { setup, error } = useGlobalSetup();
  return (
    <SettingsPage
      title="MCP"
      description={DESCRIPTIONS.global}
      sections={[
        ...notices(setup, error, "Reading your MCP servers…"),
        ...(setup ? agentSections(setup.mcp, "global") : []),
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

function ProjectMcp({ project }: { project: Workspace }) {
  // Read again when the project's folder changes, like Projects › General.
  const { setup, error } = useAgentSetup(project.slug, [project.path ?? ""]);
  const mine = (setup?.mcp ?? []).filter((server) =>
    PROJECT_SCOPES.has(server.scope),
  );
  return (
    <SettingsPage
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
        ...(setup?.folder ? agentSections(mine, "project") : []),
      ]}
    />
  );
}

/**
 * Settings › MCP and Settings › Projects › MCP: the MCP servers Claude Code
 * and Codex load.
 *
 * Every project's from the user's own config, or the ones the picked project
 * adds on top. Read-only, like the rest of agent setup.
 */
export function McpSection({ scope }: { scope: Scope }) {
  return scope === "global" ? <GlobalMcp /> : <PickedProjectMcp />;
}

function PickedProjectMcp() {
  return <PickedProjectMcpPage />;
}

function PickedProjectMcpPage() {
  const project = useSettingsProject();
  if (!project)
    return (
      <SettingsPage
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
