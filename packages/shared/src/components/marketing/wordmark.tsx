import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

/** The Lanework brand lockup: logo mark + wordmark, linking home. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn("flex items-center gap-2.5", className)}>
      <img src="/logo.png" alt="Lanework" className="size-8 rounded-lg" />
      <span className="text-[17px] font-semibold tracking-tight">Lanework</span>
    </Link>
  );
}
