import { Alert02Icon, LegalDocument01Icon } from "@hugeicons/core-free-icons";
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

/** Why the Instructions screen has nothing to show, or what went wrong. */
export function InstructionsMessage({
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
              icon={alert ? Alert02Icon : LegalDocument01Icon}
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
