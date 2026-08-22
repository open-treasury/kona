/**
 * Radix ScrollArea, in the shadcn shape, themed with Kona's tokens.
 *
 * The two things that scroll — the mutation timeline and the inspector — sit inside a CSS grid
 * whose rows are `minmax(0, 1fr)`. A native overflow container there inherits the platform
 * scrollbar, which on macOS is invisible until it moves: on a projector the timeline looks
 * like it ends at the fold, and the panel §6.10 rule 5 calls the differentiator reads as three
 * entries rather than ten. Radix renders its own always-visible track, which is the whole
 * reason to take the dependency.
 */

import * as Primitive from "@radix-ui/react-scroll-area";
import { cn } from "../lib/cn.ts";

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Primitive.ScrollAreaScrollbar>): React.ReactElement {
  return (
    <Primitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none select-none p-px transition-colors",
        orientation === "vertical" && "h-full w-2 border-l border-l-transparent",
        orientation === "horizontal" && "h-2 flex-col border-t border-t-transparent",
        className,
      )}
      {...props}
    >
      <Primitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-carbon-8 hover:bg-carbon-40"
      />
    </Primitive.ScrollAreaScrollbar>
  );
}

export function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Root>): React.ReactElement {
  return (
    <Primitive.Root
      data-slot="scroll-area"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <Primitive.ScrollAreaViewport
        data-slot="scroll-area-viewport"
        // `[&>div]:!block` undoes Radix's own inline `display: table` on the content wrapper.
        // Left alone it collapses a column of timeline entries into a single table row, and
        // the panel renders as one unreadable line.
        className="size-full rounded-[inherit] outline-none [&>div]:!block"
      >
        {children}
      </Primitive.ScrollAreaViewport>
      <ScrollBar />
      <Primitive.Corner />
    </Primitive.Root>
  );
}
