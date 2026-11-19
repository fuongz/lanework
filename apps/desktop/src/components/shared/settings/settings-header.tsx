import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import type { HarnessAgent } from "#/../shared/harness";
import type { Project } from "#/../shared/projects";
import { HARNESS_NAMES } from "#/components/shared/agents/harness-island";
import { WindowTitlebar } from "#/components/shared/navigation/window-titlebar";
import { SettingsScope } from "#/components/shared/settings/settings-scope";
import { TerminalKindIcon } from "#/components/shared/terminal/terminal-kind-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { settingsTitle } from "#/lib/settings-catalog";
import { useBoard } from "#/stores/board";

const PROJECT_PAGE = /^\/settings\/projects\/([^/]+)\/?$/;
/** A CLI's own page under Harness (FE-146). */
const HARNESS_PAGE = /^\/settings\/harness\/([^/]+)\/?$/;

const CRUMB = "text-muted-foreground shrink-0 text-[14px] leading-5";
const SLASH = "text-muted-foreground/60 shrink-0 text-[14px] leading-5";
const TITLE = "min-w-0 truncate text-[14px] leading-5 font-semibold";

/**
 * The last crumb on a CLI's page (FE-161): its mark and name, a menu that
 * goes straight to another CLI's page.
 */
function HarnessSwitcher({
  cli,
  heading,
}: {
  cli: HarnessAgent;
  heading: boolean;
}) {
  const navigate = useNavigate();
  const Title = heading ? "h1" : "span";
  // The heading holds the button, never the other way round.
  return (
    <Title className="flex min-w-0">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`${HARNESS_NAMES[cli]}, switch harness`}
              className="hover:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06] -mx-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors"
            />
          }
        >
          <TerminalKindIcon kind={cli} className="size-4 shrink-0" />
          <span className={TITLE} aria-current="page">
            {HARNESS_NAMES[cli]}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className="text-muted-foreground size-3.5 shrink-0"
            strokeWidth={2}
            aria-hidden="true"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-max min-w-44">
          <DropdownMenuRadioGroup
            value={cli}
            onValueChange={(next) =>
              void navigate({
                to: "/settings/harness/$cli",
                params: { cli: next as HarnessAgent },
              })
            }
          >
            {(Object.keys(HARNESS_NAMES) as HarnessAgent[]).map((agent) => (
              <DropdownMenuRadioItem key={agent} value={agent}>
                <TerminalKindIcon kind={agent} className="size-4 shrink-0" />
                {HARNESS_NAMES[agent]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Title>
  );
}

/**
 * Where a settings page sits, as the chat header has it: "Settings / Skills",
 * or "Settings / Projects / Acme" on a project's page, where Projects leads
 * back to the list (FE-145).
 *
 * The trail is read from the address and the nav (`settingsTitle`), so no
 * page names itself twice and every page, the hidden ones too, gets one.
 */
function SettingsBreadcrumb({ heading }: { heading: boolean }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const projects = useBoard((state) => state.projects);
  const slug = PROJECT_PAGE.exec(pathname)?.[1];
  const section = settingsTitle(pathname);

  const cli = HARNESS_PAGE.exec(pathname)?.[1] as HarnessAgent | undefined;
  const navigate = useNavigate();

  const trail: {
    label: string;
    to?: "/settings/projects" | "/settings/harness";
    /** The crumb is this CLI's switcher. */
    cli?: HarnessAgent;
    /** The crumb is this project's switcher. */
    project?: Project | null;
  }[] = [{ label: "Settings" }];
  if (slug) {
    const decoded = decodeURIComponent(slug);
    const found = projects.find((project) => project.slug === decoded) ?? null;
    trail.push(
      { label: "Projects", to: "/settings/projects" },
      { label: found?.name ?? decoded, project: found },
    );
  } else if (cli && cli in HARNESS_NAMES) {
    trail.push(
      { label: "Harness", to: "/settings/harness" },
      { label: HARNESS_NAMES[cli], cli },
    );
  } else if (section) trail.push({ label: section });

  const last = trail.length - 1;
  // A page without its own `<h1>` (the file pages) gets it here; one that
  // has one (`SettingsPage`'s) must not get a second.
  const Title = heading ? "h1" : "span";
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
      {trail.map((crumb, index) => (
        <Fragment key={crumb.label}>
          {index > 0 && (
            <span aria-hidden="true" className={SLASH}>
              /
            </span>
          )}
          {index === last && crumb.cli ? (
            <HarnessSwitcher cli={crumb.cli} heading={heading} />
          ) : index === last && crumb.project ? (
            // FE-161: the page's project, and a menu to go to another's.
            <Title className="flex min-w-0">
              <SettingsScope
                crumb
                current={crumb.project}
                onChoose={(next) =>
                  void navigate({
                    to: "/settings/projects/$slug",
                    params: { slug: next },
                  })
                }
              />
            </Title>
          ) : index === last ? (
            <Title className={TITLE} aria-current="page">
              {crumb.label}
            </Title>
          ) : crumb.to ? (
            <Link
              to={crumb.to}
              className={`${CRUMB} hover:text-foreground transition-colors duration-150`}
            >
              {crumb.label}
            </Link>
          ) : (
            <span className={CRUMB}>{crumb.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

/**
 * A settings page's 48px header row: its breadcrumb on the left and
 * `children` (a search, actions) on the right.
 *
 * The shell draws it above every page made of rows; the file pages (Skills,
 * Config files), which lay out their own card, draw it themselves.
 */
export function SettingsHeader({
  heading = false,
  children,
}: {
  /** The page has no `<h1>` of its own: the page's name is it. */
  heading?: boolean;
  children?: ReactNode;
}) {
  return (
    <WindowTitlebar>
      <SettingsBreadcrumb heading={heading} />
      {children && (
        <>
          <span className="ml-auto" />
          {children}
        </>
      )}
    </WindowTitlebar>
  );
}
