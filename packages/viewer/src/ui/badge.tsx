/**
 * The status chip, and the two smaller chips beside it.
 *
 * `tailwind-variants` earns its place here rather than being ceremony: §6.2 froze **five**
 * statuses, and the variant map is that closed set written once. A sixth would have to be
 * added here, next to the comment saying that widening a vocabulary is a spec change and not a
 * code change — which is a better place for that argument to live than scattered across three
 * components.
 *
 * The shape is the kit's `Tag`: `rounded-sm`, uppercase, `text-ui-xs` with its wide tracking,
 * and a **tinted fill carrying foreground-weight ink** rather than white on a saturated block.
 * Fourteen saturated chips on one canvas is a fruit salad; fourteen tinted ones read as a
 * legend.
 */

import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";
import type { Status } from "@kona/core";
import { cn } from "../lib/cn.ts";

const badge = tv({
  base: "inline-flex shrink-0 items-center gap-1 rounded-sm font-medium uppercase",
  variants: {
    tone: {
      active: "bg-status-active-fill text-status-active-ink",
      sending: "bg-status-sending-fill text-status-sending-ink animate-breathe",
      done: "bg-status-done-fill text-status-done-ink",
      failed: "bg-status-failed-fill text-status-failed-ink",
      dropped: "bg-status-dropped-fill text-status-dropped-ink",
      /* Outlined: everything that qualifies the node rather than states it. */
      outline: "border border-border text-carbon-40",
      reason: "border border-border text-muted-foreground",
    },
    size: {
      xs: "px-1.5 py-0.5 text-ui-xs",
      sm: "px-2 py-0.5 text-ui-xs",
    },
  },
  defaultVariants: { tone: "outline", size: "xs" },
});

export type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badge>;

export function Badge({ className, tone, size, ...props }: BadgeProps): React.ReactElement {
  return <span data-slot="badge" className={cn(badge({ tone, size }), className)} {...props} />;
}

/**
 * The status, as a chip — except for `active`, which is a bare dot.
 *
 * `active` is the commonest state on a live canvas, so a chip spelling it out on every card
 * spends the most valuable pixels restating the default. The four that are worth a word are
 * the four that are *not* the default: something is in flight, finished, broken, or abandoned.
 *
 * `sending` is ochre and breathing on purpose. §6.2 makes it the one non-terminal status that
 * looks finished from the outside: the bytes have left, and what the world did with them is
 * unknown. A green chip there would be a claim the store has not made.
 */
export function StatusBadge({
  status,
  className,
}: {
  status: Status;
  className?: string;
}): React.ReactElement {
  // `active` renders as nothing at all. The card's left rule is already green, so a chip would
  // be the third thing on screen saying the commonest fact about a node. The one dot a card
  // carries is on the right and means something the border cannot: readiness.
  if (status === "active") return <></>;
  return (
    <Badge tone={status} size="sm" className={className}>
      {status}
    </Badge>
  );
}
