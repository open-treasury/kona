/**
 * Radix Collapsible, in the shadcn shape — §6.10 rule 9's "explicit reveal".
 *
 * Everything that could be a person's words is behind one of these: the instruction, the
 * outcomes with their evidence refs, the effect log's message ids, the raw node. A `<details>`
 * element would do the same job with less code, and this was one until Radix arrived; what the
 * primitive buys is a trigger that is a real button with `aria-expanded`, and a content region
 * that reports its own height, so a reveal can animate instead of snapping the panel.
 */

import * as Primitive from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn.ts";

export function Collapsible({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Root>): React.ReactElement {
  return (
    <Primitive.Root
      data-slot="collapsible"
      className={cn("mx-3.5 mb-3 rounded-md border border-border bg-carbon-4", className)}
      {...props}
    />
  );
}

export function CollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Trigger>): React.ReactElement {
  return (
    <Primitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        "group flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5",
        "text-ui-xs font-medium text-muted-foreground uppercase",
        "hover:text-foreground focus-visible:outline-1 focus-visible:outline-primary",
        className,
      )}
      {...props}
    >
      <ChevronRight
        aria-hidden
        className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90"
      />
      {children}
    </Primitive.Trigger>
  );
}

export function CollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Content>): React.ReactElement {
  return (
    <Primitive.Content data-slot="collapsible-content" className={className} {...props}>
      <pre className="overflow-x-auto px-2.5 pb-2.5 font-mono text-[10.5px] break-words whitespace-pre-wrap text-muted-foreground">
        {children}
      </pre>
    </Primitive.Content>
  );
}
