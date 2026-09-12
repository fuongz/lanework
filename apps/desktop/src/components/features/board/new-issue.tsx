import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import type { BoardCard } from "#/../shared/workspaces";
import {
  CategoryDot,
  PriorityIcon,
  StatusIcon,
} from "#/components/shared/board/glyphs";
import {
  NONE,
  PRIORITY_LABEL,
  RAIL,
  Row,
} from "#/components/shared/board/properties";
import { TagsInput } from "#/components/shared/board/tags-input";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { categoryOf, columnOf } from "#/lib/board-view";
import { useBoard } from "#/stores/board";
import { MarkdownEditor } from "./markdown-editor";

/**
 * Compose one issue.
 *
 * ⚠️ A ROUTE, not a dialog, for the same reason the detail is one (FE-08 D5): a
 * card being written is a place you can be, so Back leaves it, ⌘K can send you
 * to it, and a half-typed issue survives a click on something else. It is also
 * the only surface with room for a description, which is the field the toolbar's
 * one-line quick-add can never offer.
 *
 * ⚠️ CATEGORY is the field this page exists for. The board mints a card's issue
 * key from it — `taskId` stays null without one — so every card the quick-add
 * had ever made was unkeyed: invisible to ⌘K, impossible to deep-link, and blank
 * in the column every list reserves for `FE-06`.
 */
export function NewIssue() {
  const { slug } = useParams({ from: "/_app/w/$slug/issues/new" });
  const navigate = useNavigate();
  const view = useBoard((state) => state.view);
  const active = useBoard((state) => state.active);
  const busy = useBoard((state) => state.busy);
  const createCard = useBoard((state) => state.createCard);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // ⚠️ Seeded from the board's own first lane rather than left empty. The
  // service defaults to it when `columnKey` is absent, so showing anything else
  // — or nothing — would be this page disagreeing with what it is about to do.
  const [columnKey, setColumnKey] = useState<string | null>(null);
  const [categoryKey, setCategoryKey] = useState(NONE);
  const [priority, setPriority] = useState(NONE);
  const [tags, setTags] = useState<string[]>([]);

  const columns = view?.columns ?? [];
  const categories = view?.categories ?? [];
  const column = columnKey ?? columns[0]?.key ?? "";
  const stale = view?.stale ?? false;
  const saving = busy === "create";
  const ready = title.trim().length > 0 && !stale && !saving;

  const leave = () =>
    void navigate({ to: "/w/$slug/issues", params: { slug }, search: {} });

  const save = async () => {
    if (!ready) return;
    const result = await createCard({
      title: title.trim(),
      ...(body.trim() ? { body: body.trim() } : {}),
      ...(categoryKey === NONE ? {} : { categoryKey }),
      ...(column ? { columnKey: column } : {}),
      ...(priority === NONE
        ? {}
        : { priority: priority as BoardCard["priority"] }),
      ...(tags.length ? { tags } : {}),
    });
    // ⚠️ Stays put on failure, with the draft intact. The reason is already on
    // screen — `WorkspaceLayout` renders the store's error across every view —
    // and navigating away would take a person's unsaved paragraph with it.
    if (result.error || !result.card) return;

    // ⚠️ The detail route is addressed by TASK ID and resolves it through
    // `lookup`, which only knows minted keys. A card created with no category
    // has none, so following it there would land on "No card called …" — the
    // list is where an unkeyed card is actually reachable.
    void navigate(
      result.card.taskId
        ? {
            to: "/w/$slug/issues/$taskId",
            params: { slug, taskId: result.card.taskId },
          }
        : { to: "/w/$slug/issues", params: { slug }, search: {} },
    );
  };

  return (
    <form
      // ⚠️ TWO PANELS, not one page with a rail floating in it. The divider runs
      // the full height and each side owns its own header band, so "what this
      // issue says" and "what this issue is" read as two places rather than one
      // column that happens to have fields at the end of it.
      className="flex min-h-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      // ⚠️ On the form, not on the title field. ⌘↵ has to save from the
      // description too — that is where the hands are when an issue is finished
      // — and Escape has to leave from anywhere for the same reason.
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
        }
        if (event.key === "Escape") leave();
      }}
    >
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="border-border flex h-11 shrink-0 items-center gap-2 border-b px-6">
          <span className="bg-foreground/[0.06] text-muted-foreground truncate rounded px-1.5 py-0.5 text-xs">
            {active?.name ?? "Project"}
          </span>
          <span className="text-muted-foreground text-xs">›</span>
          <span className="text-[13px]">New issue</span>

          <div className="ml-auto flex items-center gap-1.5">
            <Button type="button" variant="ghost" onClick={leave}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!ready}
              title={
                stale
                  ? "The board is a saved copy right now, so nothing can be created."
                  : undefined
              }
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-6">
          <Input
            aria-label="Issue title"
            placeholder="Issue title"
            value={title}
            // ⚠️ 200, the service's own `MAX_TITLE`. The quick-add allowed 500
            // for a while and the extra 300 characters only ever bought a
            // refusal at the far end of a round trip.
            maxLength={200}
            autoFocus
            disabled={stale}
            // ⚠️ No ground on focus, unlike every other borderless field in
            // this app. Those sit in a row of controls where a field has to say
            // which one you are in; these two ARE the panel, and a slab across
            // its whole width reads as a form on a surface meant to read as a
            // document. The caret carries it — and it is always in one of these
            // two, because the title takes focus on arrival.
            className="h-auto rounded-md border-0 bg-transparent px-1.5 text-xl font-semibold tracking-tight shadow-none focus-visible:border-0 focus-visible:ring-0 md:text-xl dark:bg-transparent"
            onChange={(event) => setTitle(event.target.value)}
          />
          {/* ⚠️ `min-h-0` on a flex child that scrolls. Without it the editor
              grows with its content and pushes the panel instead of scrolling
              inside it, which is the same trap the textarea here fell into. */}
          <MarkdownEditor
            label="Description"
            placeholder="Add description…"
            value={body}
            onChange={setBody}
            // ⌘↵ and Escape are bound INSIDE the editor: CodeMirror's default
            // keymap claims both, so the form's own handler never sees them
            // from the field a person is most likely to be typing in.
            onSubmit={() => void save()}
            onCancel={leave}
            readOnly={stale}
            className="min-h-0 flex-1"
          />
        </div>
      </section>

      <aside
        aria-label="Card properties"
        className="border-border flex w-72 shrink-0 flex-col border-l"
      >
        {/* The rail's own header band, the same height as the one beside it, so
            the divider between the panels has one unbroken line to draw. */}
        <header className="border-border flex h-11 shrink-0 items-center border-b px-4">
          <span className="text-[13px] font-medium">Details</span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          <Row label="Status">
            <StatusIcon column={columnOf(columns, column)} />
            <Select value={column} onValueChange={setColumnKey}>
              <SelectTrigger
                size="sm"
                aria-label="Status"
                disabled={stale || !columns.length}
                className={RAIL}
              >
                <SelectValue>
                  {(value: string) => columnOf(columns, value)?.name ?? value}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {columns.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Row label="Priority">
            <PriorityIcon
              priority={
                priority === NONE ? null : (priority as BoardCard["priority"])
              }
            />
            <Select
              value={priority}
              onValueChange={(value) => setPriority(value ?? NONE)}
            >
              <SelectTrigger
                size="sm"
                aria-label="Priority"
                disabled={stale}
                className={RAIL}
              >
                <SelectValue>
                  {(value: string) => PRIORITY_LABEL[value] ?? value}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No priority</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          </Row>

          <Row label="Category">
            <CategoryDot
              category={
                categoryKey === NONE
                  ? undefined
                  : categoryOf(categories, categoryKey)
              }
            />
            <Select
              value={categoryKey}
              onValueChange={(value) => setCategoryKey(value ?? NONE)}
            >
              <SelectTrigger
                size="sm"
                aria-label="Category"
                disabled={stale}
                className={RAIL}
              >
                <SelectValue>
                  {(value: string) =>
                    value === NONE
                      ? "No category"
                      : (categoryOf(categories, value)?.name ?? value)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No category</SelectItem>
                {categories.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Row label="Tags">
            {/* The same control the detail rail carries — a card's tags are the
                same thing whether it exists yet or not. */}
            <TagsInput tags={tags} onChange={setTags} disabled={stale} />
          </Row>

          {/* ⚠️ Said in the rail rather than discovered afterwards. Without a
              category the board mints no `FE-06`, and a key is not something a
              card can be given later without every link to it changing. */}
          {categoryKey === NONE && (
            <p className="text-muted-foreground px-1 pt-1 text-xs leading-relaxed">
              No category means no issue key, so this card cannot be opened by
              key or found in ⌘K.
            </p>
          )}
        </div>
      </aside>
    </form>
  );
}
