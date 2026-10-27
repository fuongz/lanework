import { Link, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  type InstructionAgent,
  isInstructionAgent,
} from "#/../shared/instructions";
import { MarkdownBody } from "#/components/shared/common/markdown-body";
import { InstructionsMessage } from "#/components/shared/instructions/instructions-message";
import { useSettingsProject } from "#/components/shared/settings/project-picker";
import { fileSize } from "#/lib/file-size";
import { AGENT_LABELS, SCOPE_LABELS } from "#/lib/instructions";
import { shortPath } from "#/lib/memory";
import { useInstructions } from "#/stores/instructions";

const ROUTE = "/settings/instructions/effective/$agent" as const;

/**
 * Everything one agent reads at the start of a conversation here.
 *
 * In the order it reads it, each file under a rule naming it (FE-37/D4).
 * Gathered again with every listing that lands: main's watch (FE-37/D7) and
 * window focus both list again, so this is never older than the list.
 */
export function InstructionsEffective() {
  const params = useParams({ from: ROUTE });
  const agent: InstructionAgent | null = isInstructionAgent(params.agent)
    ? params.agent
    : null;
  const slug = useSettingsProject();
  const version = useInstructions((state) =>
    state.slug === slug ? state.version : 0,
  );
  const effective = useInstructions((state) =>
    state.slug === slug && agent ? state.effective[agent] : undefined,
  );
  const error = useInstructions((state) =>
    state.slug === slug && agent ? state.effectiveErrors[agent] : undefined,
  );
  const readEffective = useInstructions((state) => state.readEffective);

  useEffect(() => {
    void version;
    if (agent) void readEffective(slug, agent);
  }, [readEffective, slug, agent, version]);

  if (!agent)
    return (
      <InstructionsMessage
        title="No such agent"
        description="Instructions are shown for Claude and Codex."
      />
    );
  if (!effective)
    return error ? (
      <InstructionsMessage
        alert
        title="Could not gather it"
        description={error}
      />
    ) : null;

  const name = AGENT_LABELS[agent];
  return (
    <section
      aria-label={`Instructions — Effective for ${name}`}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="window-drag-region border-sidebar-border flex h-11 shrink-0 items-center gap-2 border-b ps-6 pe-4">
        <h1 className="min-w-0 truncate text-[13px] font-medium">
          Effective — {name}
        </h1>
        <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
          {effective.sections.length}{" "}
          {effective.sections.length === 1 ? "file" : "files"}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full min-w-0 flex-col gap-5 px-6 py-5">
          <p className="text-muted-foreground text-xs">
            What {name} reads at the start of every conversation in this
            project, in order. Files that load only in a subfolder or on
            matching files are left out.
          </p>
          {effective.sections.length === 0 && (
            <InstructionsMessage
              title="Nothing at launch"
              description={`${name} starts a conversation here with no instruction file.`}
            />
          )}
          {effective.sections.map((section, index) => {
            const file = effective.files[section.file];
            if (!file) return null;
            const label =
              file.name === file.path ? shortPath(file.path) : file.name;
            return (
              <article
                // biome-ignore lint/suspicious/noArrayIndexKey: one file can appear once per reading, and the order never changes within one.
                key={`${section.file}-${index}`}
                aria-label={label}
                className="flex min-w-0 flex-col gap-3"
              >
                <div className="border-sidebar-border flex min-w-0 items-baseline gap-2 border-b pb-1.5">
                  {section.text !== null ? (
                    <Link
                      to="/settings/instructions/$id"
                      params={{ id: file.id }}
                      search={{ project: slug }}
                      className="decoration-foreground/30 hover:decoration-foreground min-w-0 truncate font-mono text-xs underline underline-offset-2"
                      title={file.path}
                    >
                      {label}
                    </Link>
                  ) : (
                    <span
                      className="min-w-0 truncate font-mono text-xs"
                      title={file.path}
                    >
                      {label}
                    </span>
                  )}
                  <span className="text-muted-foreground shrink-0 text-[11px]">
                    {SCOPE_LABELS[section.scope]}
                  </span>
                </div>
                {section.text === null ? (
                  <p className="text-muted-foreground text-xs">
                    {fileSize(file.size)} — not shown: only Markdown is.
                  </p>
                ) : (
                  <MarkdownBody
                    source={section.text}
                    empty="This file is empty."
                  />
                )}
                {section.truncated && (
                  <p className="text-muted-foreground text-xs">
                    {agent === "codex"
                      ? "Codex reads no further: project_doc_max_bytes, or the read limit, ends it here."
                      : "Cut here: longer than one read takes."}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
