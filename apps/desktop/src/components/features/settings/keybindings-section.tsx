import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  SettingsCard,
  SettingsPage,
} from "#/components/shared/settings/settings-page";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "#/components/ui/input-group";
import { Kbd } from "#/components/ui/kbd";
import { KEYBINDINGS } from "#/lib/keybindings";
import { matches } from "#/lib/settings-catalog";
import { useSettingsSearch } from "#/stores/settings-search";

/**
 * Settings › Keybindings: every shortcut the app handles.
 *
 * From the app menu and the screens' own key handlers (`lib/keybindings.ts`).
 * Read-only: the keys are fixed where they are handled, and recording new
 * ones would need each handler to read its key from one place first.
 */
/** "Tabs: New Tab" → "Tabs"; a command with no area is the App's. */
const areaOf = (command: string) =>
  command.includes(": ") ? command.slice(0, command.indexOf(": ")) : "App";
/** "Tabs: New Tab" → "New Tab", the row's name under its area. */
const actionOf = (command: string) =>
  command.includes(": ") ? command.slice(command.indexOf(": ") + 2) : command;

/** `bindings` by area, each area where its first shortcut was. */
function groupsOf(
  bindings: typeof KEYBINDINGS,
): [string, typeof KEYBINDINGS][] {
  const groups = new Map<string, typeof KEYBINDINGS>();
  for (const binding of bindings) {
    const area = areaOf(binding.command);
    const list = groups.get(area);
    if (list) list.push(binding);
    else groups.set(area, [binding]);
  }
  return [...groups];
}

/** Lanework's own shortcuts: the system's (Copy, Zoom, Quit…) left out. */
const OWN = KEYBINDINGS.filter((binding) => !binding.standard);

export function KeybindingsSection() {
  const query = useSettingsSearch((state) => state.query);
  const [filter, setFilter] = useState("");
  // The sidebar's search and this page's own filter both narrow the list.
  const shown = OWN.filter(
    (binding) =>
      matches(filter, binding.command, binding.keys.join(" "), binding.when) &&
      (matches(query, binding.command, binding.keys.join(" "), binding.when) ||
        matches(query, "keybindings shortcuts keys hotkeys")),
  );

  return (
    <SettingsPage
      title="Keybindings"
      description="Lanework's own shortcuts. The system's (Copy, Paste, Zoom, Quit…) and a form's usual keys (↩ or ⌘↩ to send, Esc to cancel, ⌘S to save) work as usual."
      sections={[
        {
          title: "Shortcuts",
          // Drawn below, on one row with the count and the filter.
          hideTitle: true,
          keywords: `keybindings shortcuts keys hotkeys keyboard ${OWN.map(
            (binding) => `${binding.command} ${binding.keys.join(" ")}`,
          ).join(" ")}`,
          content: (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[15px] font-medium">Shortcuts</h2>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground text-[13px] tabular-nums">
                    {shown.length === OWN.length
                      ? `${OWN.length} shortcuts`
                      : `${shown.length} of ${OWN.length}`}
                  </span>
                  <InputGroup className="w-56">
                    <InputGroupAddon>
                      <HugeiconsIcon
                        icon={Search01Icon}
                        className="size-3.5"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </InputGroupAddon>
                    <InputGroupInput
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      placeholder="Filter"
                      aria-label="Filter shortcuts"
                      className="text-xs"
                    />
                  </InputGroup>
                </div>
              </div>
              {shown.length === 0 ? (
                <SettingsCard className="overflow-hidden">
                  <Empty className="py-8">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <HugeiconsIcon icon={Search01Icon} strokeWidth={1.8} />
                      </EmptyMedia>
                      <EmptyTitle>No matching shortcuts</EmptyTitle>
                      <EmptyDescription>
                        No shortcut matches “{filter.trim() || query.trim()}”.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </SettingsCard>
              ) : (
                // One card per area (the part of a command before ":"),
                // in the list's order: Tabs, Terminal, Composer…
                groupsOf(shown).map(([area, bindings]) => (
                  <section
                    key={area}
                    aria-label={area}
                    className="mt-3 flex flex-col gap-2 first:mt-0"
                  >
                    <h3 className="text-muted-foreground px-1 text-[12px] font-medium">
                      {area}
                    </h3>
                    <SettingsCard className="overflow-hidden">
                      <table className="w-full table-fixed text-left">
                        <tbody className="divide-border divide-y">
                          {bindings.map((binding) => (
                            <tr key={binding.command} title={binding.where}>
                              <td className="truncate px-4 py-2.5 text-[13px]">
                                {actionOf(binding.command)}
                              </td>
                              <td className="w-36 px-4 py-2.5">
                                <span className="flex flex-wrap gap-1">
                                  {binding.keys.map((key) => (
                                    <Kbd
                                      key={key}
                                      // Sans, not mono: in a mono face ⌘O and ⌘0 look alike.
                                      className="h-6 min-w-6 px-1.5 text-[11px]"
                                    >
                                      {key}
                                    </Kbd>
                                  ))}
                                </span>
                              </td>
                              <td className="text-muted-foreground w-48 px-4 py-2.5 text-[13px] leading-snug">
                                {binding.when}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </SettingsCard>
                  </section>
                ))
              )}
            </div>
          ),
        },
      ]}
    />
  );
}
