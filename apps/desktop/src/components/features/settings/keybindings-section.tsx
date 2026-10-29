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
export function KeybindingsSection() {
  const query = useSettingsSearch((state) => state.query);
  const [filter, setFilter] = useState("");
  // The sidebar's search and this page's own filter both narrow the list.
  const shown = KEYBINDINGS.filter(
    (binding) =>
      matches(filter, binding.command, binding.keys.join(" "), binding.when) &&
      (matches(query, binding.command, binding.keys.join(" "), binding.when) ||
        matches(query, "keybindings shortcuts keys hotkeys")),
  );

  return (
    <SettingsPage
      title="Keybindings"
      description="Every shortcut in the app."
      sections={[
        {
          title: "Shortcuts",
          // Drawn below, on one row with the count and the filter.
          hideTitle: true,
          keywords: `keybindings shortcuts keys hotkeys keyboard ${KEYBINDINGS.map(
            (binding) => `${binding.command} ${binding.keys.join(" ")}`,
          ).join(" ")}`,
          content: (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[15px] font-medium">Shortcuts</h2>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground text-[13px] tabular-nums">
                    {shown.length === KEYBINDINGS.length
                      ? `${KEYBINDINGS.length} shortcuts`
                      : `${shown.length} of ${KEYBINDINGS.length}`}
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
              <SettingsCard className="overflow-hidden">
                {shown.length === 0 ? (
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
                ) : (
                  <table className="w-full table-fixed text-left">
                    <thead className="border-border border-b">
                      <tr className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                        <th className="px-4 py-2.5 font-medium">Command</th>
                        <th className="w-36 px-4 py-2.5 font-medium">
                          Keybinding
                        </th>
                        <th className="w-48 px-4 py-2.5 font-medium">When</th>
                      </tr>
                    </thead>
                    <tbody className="divide-border divide-y">
                      {shown.map((binding) => (
                        <tr key={binding.command} title={binding.where}>
                          <td className="truncate px-4 py-2.5 text-[13px]">
                            {binding.command}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="flex flex-wrap gap-1">
                              {binding.keys.map((key) => (
                                <Kbd
                                  key={key}
                                  className="h-6 min-w-6 px-1.5 font-mono text-[11px]"
                                >
                                  {key}
                                </Kbd>
                              ))}
                            </span>
                          </td>
                          <td className="text-muted-foreground px-4 py-2.5 text-[13px] leading-snug">
                            {binding.when}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </SettingsCard>
            </div>
          ),
        },
      ]}
    />
  );
}
