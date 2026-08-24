/**
 * Radix Tooltip, in the shadcn shape.
 *
 * It replaces the `title` attribute, which was doing real work on the canvas — an activity's full
 * instruction, the effect class behind the ⚡, what the ready dot means. The native tooltip
 * takes about a second to appear, renders in the OS chrome rather than the page, and cannot be
 * read at a glance while somebody is talking over it. All three matter for a thing whose job
 * is to be looked at.
 *
 * §6.10 rule 9 still applies inside a tooltip: this is for *structure* — an instruction, a
 * class, a deadline — never for a counterparty's words. Message bodies stay behind the
 * inspector's explicit reveal.
 */

import * as Primitive from "@radix-ui/react-tooltip";
import { cn } from "../lib/cn.ts";

export function TooltipProvider({
  delayDuration = 200,
  ...props
}: React.ComponentProps<typeof Primitive.Provider>): React.ReactElement {
  return <Primitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

export function Tooltip(props: React.ComponentProps<typeof Primitive.Root>): React.ReactElement {
  return <Primitive.Root data-slot="tooltip" {...props} />;
}

export function TooltipTrigger(
  props: React.ComponentProps<typeof Primitive.Trigger>,
): React.ReactElement {
  return <Primitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Content>): React.ReactElement {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // Inverted against the page on purpose. A tooltip is transient and has to be
          // separable from the card it is covering at a glance; a white panel over a white
          // card reads as part of the card.
          "z-50 max-w-80 rounded-md bg-foreground px-2.5 py-1.5",
          "font-mono text-[10.5px] leading-relaxed text-background shadow-lg",
          "origin-(--radix-tooltip-content-transform-origin)",
          className,
        )}
        {...props}
      >
        {children}
        <Primitive.Arrow className="z-50 size-2 translate-y-[calc(-50%_-_1px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </Primitive.Content>
    </Primitive.Portal>
  );
}
