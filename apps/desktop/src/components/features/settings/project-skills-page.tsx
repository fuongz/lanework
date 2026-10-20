import { Alert02Icon, FolderOpenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import type { SetupDoc, SetupFile } from "#/../shared/agent-setup";
import type { Workspace } from "#/../shared/workspaces";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { EditorTabs } from "#/components/shared/editor/editor-tabs";
import {
  WINDOW_TITLE,
  WindowTitlebar,
} from "#/components/shared/navigation/window-titlebar";
import {
  FileBrowserLayout,
  FileBrowserPath,
  FileBrowserTree,
  treePath,
} from "#/components/shared/settings/file-browser";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { ipcMessage } from "#/lib/ipc-error";
import { useSettingsProject } from "#/stores/settings-project";
import { useAgentSetup } from "./use-agent-setup";

/**
 * One open skill, read-only: its frontmatter as written, then its body as
 * markdown — what the agent setup's file dialog shows, in a pane.
 */
function SkillPane({ slug, skill }: { slug: string; skill: SetupDoc }) {
  const [file, setFile] = useState<SetupFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const surface = window.desktop?.agentSetup;
    if (!surface) return;
    let live = true;
    surface.open(slug, skill.id).then(
      (next) => live && setFile(next),
      (failure: unknown) =>
        live && setError(ipcMessage(failure, "Could not open that skill.")),
    );
    return () => {
      live = false;
    };
  }, [slug, skill.id]);

  async function reveal() {
    try {
      await window.desktop?.agentSetup.reveal(slug, skill.id);
    } catch (failure) {
      setError(ipcMessage(failure, "Could not show that file in Finder."));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileBrowserPath path={treePath(skill.source)}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reveal in Finder"
          title="Reveal in Finder"
          disabled={!file}
          onClick={() => void reveal()}
        >
          <HugeiconsIcon
            icon={FolderOpenIcon}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </Button>
      </FileBrowserPath>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        {skill.disabled && (
          <Alert>
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
            <AlertDescription>{skill.disabled}</AlertDescription>
          </Alert>
        )}
        {file?.truncated && (
          <Alert>
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} />
            <AlertDescription>
              This file is longer than one read takes; what is shown is its
              start.
            </AlertDescription>
          </Alert>
        )}
        {file?.frontmatter && (
          // Wide lines scroll inside the box; the pane never scrolls sideways.
          <pre
            data-testid="agent-setup-frontmatter"
            className="bg-foreground/[0.04] text-muted-foreground overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre"
          >
            {file.frontmatter}
          </pre>
        )}
        {file && <MarkdownBody source={file.body} />}
        {error && (
          <p role="alert" className="text-destructive text-[13px]">
            {error}
          </p>
        )}
        {!file && !error && (
          <p className="text-muted-foreground text-[13px]">Opening…</p>
        )}
      </div>
    </div>
  );
}

function Placeholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const NO_SKILLS =
  "Skills in the project's .claude, .agents or .codex folder show here.";

function Skills({ project }: { project: Workspace }) {
  // Read again when the project's folder changes, like Projects › General.
  const { setup, error } = useAgentSetup(project.slug, [project.path ?? ""]);
  // ⚠️ Open tabs by id: an id is stable across reads, so a tab survives the
  // re-read on window focus — and says so when its skill is gone.
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const skills = (setup?.skills ?? []).filter(
    (skill) => skill.scope === "project",
  );
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const current = active ? (byId.get(active) ?? null) : null;

  function open(id: string) {
    setTabs((previous) =>
      previous.includes(id) ? previous : [...previous, id],
    );
    setActive(id);
  }

  function close(id: string) {
    const index = tabs.indexOf(id);
    const next = tabs.filter((tab) => tab !== id);
    setTabs(next);
    // Closing the open one moves to its neighbour, the one on the left first.
    if (active === id) setActive(next[Math.max(0, index - 1)] ?? null);
  }

  let pane: ReactNode;
  if (setup && !setup.folder)
    pane = (
      <Placeholder
        title="This project has no folder on this machine"
        description="Link a folder to see its skills."
      />
    );
  else if (setup && skills.length === 0)
    pane = (
      <Placeholder title="No skills in this project" description={NO_SKILLS} />
    );
  else if (current)
    pane = <SkillPane key={current.id} slug={project.slug} skill={current} />;
  else if (active)
    pane = (
      <Placeholder
        title="That skill is no longer there"
        description="Pick it again from the list."
      />
    );
  else
    pane = setup ? (
      <Placeholder title="Pick a skill" description={NO_SKILLS} />
    ) : null;

  return (
    <FileBrowserLayout
      id="lanework:project-skills"
      title="Skills"
      sidebar={
        error ? (
          <p role="alert" className="text-destructive px-3.5 py-2 text-[13px]">
            {error}
          </p>
        ) : setup ? (
          skills.length > 0 ? (
            <FileBrowserTree
              entries={skills.map((skill) => ({
                id: skill.id,
                path: treePath(skill.source),
              }))}
              active={active}
              onOpen={open}
              noun="skill"
            />
          ) : (
            <p className="text-muted-foreground px-3.5 py-3 text-xs">
              No skills.
            </p>
          )
        ) : (
          <p className="text-muted-foreground px-3.5 py-3 text-xs">
            Reading skills…
          </p>
        )
      }
    >
      {setup?.folder && skills.length > 0 && (
        <EditorTabs
          label="Open skills"
          tabs={tabs.map((id) => {
            const skill = byId.get(id);
            return {
              id,
              label: skill?.name ?? "Removed skill",
              path: skill ? treePath(skill.source) : "SKILL.md",
            };
          })}
          active={active}
          onActivate={setActive}
          onClose={close}
        />
      )}
      {pane}
    </FileBrowserLayout>
  );
}

/**
 * Settings › Projects › Skills: the skills the picked project's own folder
 * brings — `.claude/skills` for Claude Code, `.agents/skills` and
 * `.codex/skills` for Codex — as a tree by folder, beside the open ones in
 * tabs. Read-only: the user's own skills are Settings › Skills, and edited
 * there.
 */
export function ProjectSkillsPage() {
  const project = useSettingsProject();
  if (!project)
    return (
      <div className="flex h-full flex-col">
        <WindowTitlebar>
          <h1 className={WINDOW_TITLE}>Skills</h1>
        </WindowTitlebar>
        <Placeholder
          title="No projects yet"
          description="Add a project to see its skills."
        />
      </div>
    );
  // Keyed by slug: another project's tabs never carry over.
  return <Skills key={project.slug} project={project} />;
}
