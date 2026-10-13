"use client";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { cn } from "cn";

/**
 * Right click, or long press.
 *
 * ⚠️ The same popup language as `dropdown-menu`, deliberately: one menu surface
 * in this app, whether it was opened by a button or by a right click. What it is
 * NOT is the same positioner — a dropdown is anchored to its trigger and takes
 * `--anchor-width` from it, while this one is anchored to the pointer, where
 * that variable is a zero-width point.
 */
function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root {...props} />;
}

function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  );
}

function ContextMenuContent({
  className,
  ...props
}: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="isolate z-50 outline-none">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            // Glass: a thin tint over a heavy blur, a hairline rim and a lit top
            // edge — the macOS menu, not a card. The blur sits on `::before`
            // so the popup's own scroll clip never cuts it off.
            "relative z-50 max-h-(--available-height) min-w-48 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-xl bg-popover/55 p-1 dark:bg-muted/60 text-popover-foreground shadow-[0_12px_40px_-8px_rgb(0_0_0/0.45),inset_0_1px_0_0_rgb(255_255_255/0.06)] ring-1 ring-foreground/12 outline-none dark:ring-foreground/15 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-3xl before:backdrop-saturate-[1.8] **:data-[slot$=-item]:data-highlighted:bg-foreground/10",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  variant = "default",
  ...props
}: ContextMenuPrimitive.Item.Props & {
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        "relative flex min-h-8 cursor-default items-center gap-2 rounded-lg px-2.5 py-1 text-[13px] outline-hidden select-none data-[variant=destructive]:text-destructive data-[variant=destructive]:data-highlighted:bg-destructive/15 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 data-[variant=destructive]:*:[svg]:text-destructive dark:data-[variant=destructive]:data-highlighted:bg-destructive/30",
        className,
      )}
      {...props}
    />
  );
}

/**
 * ⚠️ Required around a `ContextMenuLabel`. Base UI throws — error #31, "MenuGroupContext
 * is missing" — for a group label with no group, and in a production build that
 * arrives as an error CODE with the whole renderer replaced by the boundary.
 */
function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  );
}

function ContextMenuLabel({
  className,
  ...props
}: ContextMenuPrimitive.GroupLabel.Props) {
  return (
    <ContextMenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      className={cn("px-2.5 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-foreground/10", className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
};
