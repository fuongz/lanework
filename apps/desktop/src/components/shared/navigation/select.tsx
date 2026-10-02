import type { ComponentProps } from "react";
import {
  SelectContent as RegistrySelectContent,
  SelectItem as RegistrySelectItem,
} from "#/components/ui/select";
import { cn } from "#/lib/utils";
import { RAIL_ROW, RailHover } from "./rail-hover";

export * from "#/components/ui/select";

/** App-wide hover animation, composed outside the registry-owned primitive. */
export function SelectContent({
  children,
  ...props
}: ComponentProps<typeof RegistrySelectContent>) {
  return (
    <RegistrySelectContent {...props}>
      <RailHover className="[&[data-hovering=true]_[data-slot=select-item]]:bg-transparent">
        {children}
      </RailHover>
    </RegistrySelectContent>
  );
}

export function SelectItem({
  className,
  ...props
}: ComponentProps<typeof RegistrySelectItem>) {
  return <RegistrySelectItem className={cn(RAIL_ROW, className)} {...props} />;
}
