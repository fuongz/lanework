import { Alert02Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type {
  AgentSetup,
  SetupAgent,
  SetupDoc,
  SetupOrigin,
  SetupPermissionKind,
  SetupScope,
} from "#/../shared/agent-setup";
import { SettingsCard } from "#/components/shared/settings/settings-page";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { cn } from "#/lib/utils";
import { AgentSetupFileDialog } from "./agent-setup-file-dialog";
import { useAgentSetup } from "./use-agent-setup";

const AGENTS: Record<SetupAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

const SCOPES: Record<SetupScope, string> = {
  user: "User",
  project: "Project",
  local: "Local",
  plugin: "Plugin",
  system: "System",
};

const PERMISSION_KINDS: Record<SetupPermissionKind, string> = {
  allow: "Allow",
  ask: "Ask",
  deny: "Deny",
  mode: "Default mode",
  directory: "Directory",
  auto: "Auto mode",
  approval: "Approvals",
  sandbox: "Sandbox",
  trust: "Trust",
};

/** Rows a group shows before "Show all" — Commands and Hooks can run long. */
const FOLDED = 6;

/**
 * One row of a group's card (FE-40/D3): what it is, which agent and scope
 * load it and from where, and — dimmed, with the reason under it — whether
 * that agent will actually use it.
 */
function SetupRow({
  origin,
  title,
  lead,
  detail,
  mono,
  trailing,
  onOpen,
}: {
  origin: SetupOrigin;
  title: string;
  /** A short word before the title — a permission's kind. */
  lead?: string;
  detail?: string | null;
  /** The title is code: a rule, a command. */
  mono?: boolean;
  trailing?: ReactNode;
  /** Opens the row (D4); the whole row is then the button. */
  onOpen?: () => void;
}) {
  const where = origin.plugin ?? origin.source;
  const body = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div
          className={cn(
            "flex min-w-0 items-center gap-2 overflow-hidden",
            origin.disabled && "opacity-55",
          )}
        >
          {lead && (
            <span className="text-muted-foreground w-24 shrink-0 text-[13px]">
              {lead}
            </span>
          )}
          {/* ⚠️ The name keeps its room and the file gives way: a config
              dir outside `~` is a long absolute path, and it squeezed names
              down to "lo…". */}
          <span
            className={cn(
              "max-w-[65%] shrink-0 truncate text-sm font-medium",
              mono && "font-mono text-[13px] font-normal",
            )}
            title={title}
          >
            {title}
          </span>
          <Badge variant="outline">{AGENTS[origin.agent]}</Badge>
          <Badge variant="outline">{SCOPES[origin.scope]}</Badge>
          <span
            className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
            title={origin.source}
          >
            {where}
          </span>
        </div>
        {detail && (
          <span
            className={cn(
              "text-muted-foreground truncate text-[13px] leading-relaxed",
              lead && "pl-26",
              origin.disabled && "opacity-55",
            )}
            title={detail}
          >
            {detail}
          </span>
        )}
        {origin.disabled && (
          <span
            data-testid="agent-setup-disabled"
            className={cn(
              "text-muted-foreground text-xs leading-relaxed",
              lead && "pl-26",
            )}
          >
            {origin.disabled}
          </span>
        )}
      </div>
      {trailing && (
        <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>
      )}
    </>
  );
  const className = "flex w-full items-start gap-4 px-4 py-3 text-left";
  return onOpen ? (
    <button
      type="button"
      data-disabled={origin.disabled ? "" : undefined}
      aria-label={`Open ${title}`}
      className={cn(
        className,
        "hover:bg-muted/50 focus-visible:bg-muted/50 outline-none first:rounded-t-xl last:rounded-b-xl",
      )}
      onClick={onOpen}
    >
      {body}
    </button>
  ) : (
    <div data-disabled={origin.disabled ? "" : undefined} className={className}>
      {body}
    </div>
  );
}

/**
 * One group — MCP, Skills, … — as a card of hairline rows like every other
 * Settings section (FE-40/D1), folded after a few.
 */
function SetupGroup<T extends SetupOrigin>({
  title,
  items,
  empty,
  row,
}: {
  title: string;
  items: T[];
  empty: string;
  row: (item: T) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, FOLDED);
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h4 className="text-muted-foreground flex items-baseline gap-1.5 text-[13px] font-medium">
        {title}
        <span className="text-muted-foreground/70 tabular-nums">
          {items.length}
        </span>
      </h4>
      <SettingsCard>
        {items.length === 0 ? (
          <Empty className="py-4">
            <EmptyHeader>
              <EmptyDescription>{empty}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          shown.map(row)
        )}
        {items.length > FOLDED && (
          <div className="px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground w-full"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? "Show fewer" : `Show all ${items.length}`}
            </Button>
          </div>
        )}
      </SettingsCard>
    </section>
  );
}

function Groups({
  setup,
  onOpen,
}: {
  setup: AgentSetup;
  onOpen: (doc: SetupDoc) => void;
}) {
  const navigate = useNavigate();
  return (
    <>
      <SetupGroup
        title="MCP servers"
        items={setup.mcp}
        empty="No MCP server is configured for this folder."
        row={(server) => (
          <SetupRow
            key={server.id}
            origin={server}
            title={server.name}
            trailing={
              <span className="text-muted-foreground font-mono text-xs">
                {[server.transport, server.target].filter(Boolean).join(", ")}
              </span>
            }
          />
        )}
      />
      {/* Skills have their own page, Settings › Skills (FE-47/D9). */}
      <SetupGroup
        title="Commands"
        items={setup.commands}
        empty="No slash commands."
        row={(command) => (
          <SetupRow
            key={command.id}
            origin={command}
            title={`/${command.name}`}
            detail={command.description}
            onOpen={() => onOpen(command)}
          />
        )}
      />
      <SetupGroup
        title="Hooks"
        items={setup.hooks}
        empty="No hooks."
        row={(hook) => (
          <SetupRow
            key={hook.id}
            origin={hook}
            title={
              hook.matcher ? `${hook.event} (${hook.matcher})` : hook.event
            }
            detail={
              hook.type === "command"
                ? hook.detail
                : [hook.type, hook.detail].filter(Boolean).join(", ")
            }
            trailing={
              // D5: Lanework's own checkpoint hook, and where it is managed.
              hook.lanework ? (
                <>
                  <Badge variant="secondary">Lanework checkpoint</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => void navigate({ to: "/settings/agents" })}
                  >
                    Settings › Harness
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      strokeWidth={1.8}
                      data-icon="inline-end"
                    />
                  </Button>
                </>
              ) : null
            }
          />
        )}
      />
      <SetupGroup
        title="Permissions"
        items={setup.permissions}
        empty="No permission rules."
        row={(rule) => (
          <SetupRow
            key={rule.id}
            origin={rule}
            lead={PERMISSION_KINDS[rule.kind]}
            title={rule.value}
            mono={
              rule.kind === "allow" ||
              rule.kind === "ask" ||
              rule.kind === "deny" ||
              rule.kind === "directory"
            }
          />
        )}
      />
      <SetupGroup
        title="Plugins"
        items={setup.plugins}
        empty="No plugins."
        row={(plugin) => (
          <SetupRow
            key={plugin.id}
            origin={plugin}
            title={plugin.name}
            trailing={
              plugin.version ? (
                <span className="text-muted-foreground font-mono text-xs">
                  {plugin.version}
                </span>
              ) : null
            }
          />
        )}
      />
    </>
  );
}

/**
 * What Claude Code and Codex load in this project's folder (FE-40): MCP
 * servers, skills, commands, hooks, permissions and plugins, from every
 * config file on this Mac that says so. Read-only — nothing here changes
 * them, and nothing secret is in what main sends.
 */
export function AgentSetupSection({
  slug,
  folders,
}: {
  slug: string;
  folders: string[];
}) {
  const { setup, error } = useAgentSetup(slug, folders);
  const [doc, setDoc] = useState<SetupDoc | null>(null);

  return (
    <section aria-label="Agent setup" className="mt-9 flex flex-col gap-3">
      <h3 className="text-[15px] font-medium">Agent setup</h3>
      <p className="text-muted-foreground -mt-1 text-[13px] leading-relaxed">
        What Claude Code and Codex load in this project’s folder, as their
        config files on this Mac say. Dimmed entries are configured but not in
        use.
      </p>
      {error && (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      )}
      {setup && !setup.folder && (
        <SettingsCard>
          <Empty className="py-8">
            <EmptyHeader>
              {/* ⚠️ Not "No folder on this machine": the row above says
                  that already, and specs count it. */}
              <EmptyTitle>No folder linked</EmptyTitle>
              <EmptyDescription>
                Link this project to a folder on this Mac to see what Claude
                Code and Codex load there.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsCard>
      )}
      {setup?.folder && setup.unreadable.length > 0 && (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
          <AlertTitle>Some config files could not be read</AlertTitle>
          <AlertDescription className="font-mono">
            {setup.unreadable.join(", ")}
          </AlertDescription>
        </Alert>
      )}
      {setup?.folder && <Groups setup={setup} onOpen={setDoc} />}
      {!setup && !error && (
        <p className="text-muted-foreground text-[13px]">
          Reading this project’s agent setup…
        </p>
      )}
      <AgentSetupFileDialog
        slug={slug}
        doc={doc}
        onOpenChange={(open) => !open && setDoc(null)}
      />
    </section>
  );
}
