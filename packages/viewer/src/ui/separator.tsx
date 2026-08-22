/** Radix Separator, in the shadcn shape. Decorative by default, so it stays out of the a11y tree. */

import * as Primitive from "@radix-ui/react-separator";
import { cn } from "../lib/cn.ts";

export function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof Primitive.Root>): React.ReactElement {
  return (
    <Primitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-carbon-8",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}
