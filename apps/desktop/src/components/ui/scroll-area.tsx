import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type { Ref } from "react";
import { cn } from "#/lib/utils";

/**
 * A scroller whose bar floats over the content instead of taking its width.
 *
 * The app's own `::-webkit-scrollbar` is a classic 10px gutter (see
 * `app.css`). A narrow list that scrolls loses those 10px only while it is
 * long enough to scroll, so its rows shift sideways; this bar sits over the
 * rows and shows only while scrolling or hovered.
 */
function ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  viewportClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative min-h-0 overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full overscroll-contain outline-none",
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-0.5 opacity-0 transition-opacity duration-150 select-none data-[hovering]:opacity-100 data-[scrolling]:opacity-100 data-[scrolling]:duration-0",
        "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5",
        "data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="bg-foreground/20 hover:bg-foreground/35 relative flex-1 rounded-full"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
