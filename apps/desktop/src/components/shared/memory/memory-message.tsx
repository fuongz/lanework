import { Alert02Icon, Brain02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";

/** Why the Memory screen has nothing to show, or what went wrong. */
export function MemoryMessage({
  title,
  description,
  alert = false,
  children,
}: {
  title: string;
  description: string;
  alert?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center">
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon
              icon={alert ? Alert02Icon : Brain02Icon}
              strokeWidth={1.8}
            />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription className="break-words">
            {description}
          </EmptyDescription>
        </EmptyHeader>
        {children && <EmptyContent>{children}</EmptyContent>}
      </Empty>
    </div>
  );
}
