/**
 * The small chips: a reason code on a timeline row, a quorum counter on a card.
 *
 * **Status is not one of them.** It used to be — a filled chip per state — and it is now the
 * circular glyph in `graph/NodeCard.tsx`, in the GitHub Actions idiom: a ring you read by its
 * shape before you read it by its colour, which costs a third of the width a word does and
 * survives being zoomed out. The five-status vocabulary §6.2 froze lives there now, in one
 * place, rather than half here and half there.
 *
 * The shape is the kit's `Tag`: `rounded-sm`, uppercase, `text-ui-xs` with its wide tracking.
 */

import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";
import { cn } from "../lib/cn.ts";

const badge = tv({
  base: "inline-flex shrink-0 items-center gap-1 rounded-sm font-medium uppercase",
  variants: {
    tone: {
      /** Qualifies a node rather than stating it — the quorum counter. */
      outline: "border border-border text-carbon-40",
      /** §6.3's machine-readable half of the rationale, on a timeline row. */
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
