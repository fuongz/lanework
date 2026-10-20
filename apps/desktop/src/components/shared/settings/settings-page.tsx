import type { ReactNode } from "react";
import { matches } from "#/lib/settings-catalog";
import { cn } from "#/lib/utils";
import { useSettingsSearch } from "#/stores/settings-search";

/**
 * Every text button on a settings row, one size: Danger zone's (pass with
 * `size="lg"`). A destructive one adds `border-0` — see `account-section.tsx`.
 */
export const SETTINGS_BUTTON =
  "h-8 gap-1.5 rounded-lg px-3 text-sm has-[>svg:first-child]:pl-2.5";

export interface SettingsRowSpec {
  label: string;
  description?: string;
  /** The control on the right: a switch, a button, or plain text. */
  control?: ReactNode;
  /** Extra words the search box matches, beyond label and description. */
  keywords?: string;
}

export interface SettingsSectionSpec {
  title: string;
  rows?: SettingsRowSpec[];
  /**
   * A section that is not a list of rows — rendered in place of the row card.
   *
   * Theme previews are the reason this exists: they are three pictures to pick
   * between, not a labelled control on the right of a line.
   */
  content?: ReactNode;
  /** Searchable words for a `content` section, which has no rows to match on. */
  keywords?: string;
  /**
   * Keep `title` for search and screen readers but draw no heading — for a
   * section whose first row already says what it is (Projects → the selected
   * project's own name and avatar).
   */
  hideTitle?: boolean;
  /** A heading in the destructive tone — Danger zone. */
  destructive?: boolean;
}

/**
 * A settings section page: title, a line of prose, and grouped rows.
 *
 * ⚠️ Sections and rows are DATA rather than children, and that is what makes
 * search work. Filtering `children` would leave a section heading above an
 * empty card, and nothing could tell that the whole page matched nothing —
 * which is exactly the state that needs its own message.
 */
export function SettingsPage({
  title,
  description,
  sections,
}: {
  title: string;
  description: string;
  sections: SettingsSectionSpec[];
}) {
  const query = useSettingsSearch((state) => state.query);

  const visible = sections
    .map((section) => ({
      ...section,
      rows: (section.rows ?? []).filter((row) =>
        matches(query, row.label, row.description, row.keywords, section.title),
      ),
    }))
    // A `content` section has no rows to narrow, so it matches on its own words
    // or not at all.
    .filter((section) =>
      section.content
        ? matches(query, section.title, section.keywords)
        : section.rows.length > 0,
    );

  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {description}
      </p>

      {visible.length === 0 ? (
        <p className="text-muted-foreground mt-12 text-sm">
          Nothing on this page matches “{query.trim()}”.
        </p>
      ) : (
        visible.map((section) => (
          <section key={section.title} className="mt-9 flex flex-col gap-3">
            <h2
              className={cn(
                "text-[15px] font-medium",
                section.hideTitle && "sr-only",
                section.destructive && "text-destructive",
              )}
            >
              {section.title}
            </h2>
            {section.content ?? (
              <SettingsCard>
                {section.rows.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between gap-8 px-4 py-3.5"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-medium">{row.label}</span>
                      {row.description ? (
                        <span className="text-muted-foreground text-[13px] leading-relaxed">
                          {row.description}
                        </span>
                      ) : null}
                    </div>
                    {row.control ? (
                      <div className="flex shrink-0 items-center">
                        {row.control}
                      </div>
                    ) : null}
                  </div>
                ))}
              </SettingsCard>
            )}
          </section>
        ))
      )}
    </div>
  );
}

/**
 * The card a settings section's rows sit in.
 *
 * ⚠️ Exported so a `content` section — a list this component cannot describe as
 * rows — draws the SAME container instead of restating the classes. Two
 * hand-written copies is how one settings page ends up with a card and the next
 * with a bare list, which is the state this app has already been in once.
 */
export function SettingsCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "divide-border bg-card shadow-card divide-y rounded-xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A read-only value on the right of a row. */
export function SettingsValue({ children }: { children: ReactNode }) {
  return (
    <code className="text-muted-foreground max-w-[22rem] truncate text-[13px] select-all">
      {children}
    </code>
  );
}
