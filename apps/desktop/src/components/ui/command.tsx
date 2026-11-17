import { SearchIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "cn";
import { motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Kbd, KbdGroup } from "#/components/ui/kbd";

/**
 * Inside a `CommandDialog` (a palette, as ⌘K draws it): a taller field, roomier
 * rows, a highlight that slides to the selected row in the accent, and the
 * keys under the list. In a popover (menus, pickers) the compact look stays.
 *
 * NOTE: A local change to a registry file; the next `shadcn add command`
 * loses it.
 */
const PaletteContext = createContext(false);

/** How the palette's highlight slides; the rail's hover spring. */
const SLIDE = {
  type: "spring",
  stiffness: 900,
  damping: 50,
  mass: 0.4,
} as const;

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        // No surface of its own: it sits on the popover's (menu glass) or the
        // dialog's, edge to edge.
        "flex size-full flex-col overflow-hidden text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        // The ⌘K palette's frame (command-palette.tsx): a frosted page
        // behind, a wide rounded card high on the screen, the keys below.
        overlayClassName="bg-background/45 supports-backdrop-filter:backdrop-blur-[3px]"
        className={cn(
          "top-[14%] max-w-xl translate-y-0 gap-0 overflow-hidden rounded-2xl! p-0 shadow-[0_24px_60px_-16px_rgb(0_0_0/0.22)] sm:max-w-xl",
          className,
        )}
        showCloseButton={showCloseButton}
      >
        <PaletteContext.Provider value={true}>
          {children}
        </PaletteContext.Provider>
        <div className="border-border bg-muted/40 text-muted-foreground flex h-10 shrink-0 items-center gap-4 border-t px-4 text-[12px]">
          <span className="flex items-center gap-1.5">
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </KbdGroup>
            Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Enter</Kbd>
            Select
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd>
            Close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The search field, edge to edge across the top of the list.
 *
 * A rule under it makes it the menu's header, not a boxed input inside it.
 * `trailing` sits at its end (a Clear).
 */
function CommandInput({
  className,
  trailing,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  trailing?: React.ReactNode;
}) {
  const palette = useContext(PaletteContext);
  return (
    <div
      data-slot="command-input-wrapper"
      className={cn(
        "flex shrink-0 items-center",
        palette
          ? "h-12 gap-2.5 px-4"
          : "border-foreground/10 h-9 gap-2 border-b ps-3 pe-1.5",
      )}
    >
      <HugeiconsIcon
        icon={SearchIcon}
        strokeWidth={palette ? 1.8 : 2}
        className={cn(
          "text-muted-foreground shrink-0",
          palette ? "size-4" : "size-3.5",
        )}
        aria-hidden="true"
      />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
          palette ? "text-[14px]" : "text-[13px]",
          className,
        )}
        {...props}
      />
      {trailing}
    </div>
  );
}

function CommandList({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  const palette = useContext(PaletteContext);
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
        palette ? "relative px-2 pb-2" : "p-1",
        className,
        // Over a caller's own height: a palette is as tall as ⌘K's.
        palette && "max-h-[min(26rem,60vh)]",
      )}
      {...props}
    >
      {palette && <SlidingHighlight />}
      {children}
    </CommandPrimitive.List>
  );
}

/**
 * The palette's one highlight, sliding to the selected row as ⌘K's does.
 * cmdk marks that row (`data-selected`); this follows the mark. It jumps into
 * place on the first one, and with reduced motion.
 */
function SlidingHighlight() {
  const self = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const placed = useRef(false);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    // The list: the highlight's parent, and the rows' offset parent.
    const list = self.current?.parentElement;
    if (!list) return;
    const measure = () => {
      const row = list.querySelector<HTMLElement>(
        '[data-slot="command-item"][data-selected="true"]',
      );
      setBox(
        row
          ? {
              x: row.offsetLeft,
              y: row.offsetTop,
              width: row.offsetWidth,
              height: row.offsetHeight,
            }
          : null,
      );
    };
    measure();
    const watch = new MutationObserver(measure);
    watch.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-selected"],
    });
    return () => watch.disconnect();
  }, []);
  const jump = reduced || !placed.current;
  if (box) placed.current = true;
  return (
    <div ref={self} aria-hidden="true" className="contents">
      {box && (
        <motion.div
          className="bg-rail-active pointer-events-none absolute top-0 left-0 rounded-lg"
          initial={false}
          animate={box}
          transition={jump ? { duration: 0 } : SLIDE}
        />
      )}
    </div>
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn(
        "text-muted-foreground py-5 text-center text-[13px]",
        className,
      )}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden text-foreground not-first:mt-1 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pt-1.5 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:text-[11px] **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 my-1 h-px bg-foreground/10", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  const palette = useContext(PaletteContext);
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-default items-center outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 data-selected:*:[svg]:text-foreground",
        // In a palette the sliding highlight is the selection's background.
        palette
          ? "min-h-9 gap-3 rounded-lg px-2.5 py-2 text-[13.5px]"
          : "min-h-7 gap-2 rounded-md px-2 py-1 text-[13px] data-selected:bg-foreground/[0.08]",
        className,
      )}
      {...props}
    >
      {children}
      <HugeiconsIcon
        icon={Tick02Icon}
        strokeWidth={2}
        className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100"
      />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-[0.625rem] tracking-widest text-muted-foreground group-data-selected/command-item:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
