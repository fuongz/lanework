import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/** Primary marketing call-to-action: emerald gradient, shine sweep, springy press. */
const VARIANTS = {
  primary:
    "bg-gradient-to-b from-emerald-500 to-emerald-600 text-white shadow-emerald-600/25 ring-white/20 hover:shadow-emerald-600/40 focus-visible:ring-emerald-400/60",
  invert:
    "bg-white text-emerald-700 shadow-black/15 ring-black/[0.06] hover:shadow-black/25 focus-visible:ring-white/70",
} as const;

export function CtaButton({
  children,
  onClick,
  size = "lg",
  variant = "primary",
  className,
  pending = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  size?: "sm" | "lg";
  variant?: keyof typeof VARIANTS;
  className?: string;
  /** Disables interaction and signals a busy state (e.g. while redirecting). */
  pending?: boolean;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-busy={pending}
      whileHover={pending ? undefined : { y: -2 }}
      whileTap={pending ? undefined : { scale: 0.97 }}
      transition={{ type: "spring", stiffness: 400, damping: 22 }}
      className={cn(
        "group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-xl font-semibold shadow-lg ring-1 ring-inset transition-shadow hover:shadow-xl focus-visible:outline-none focus-visible:ring-2",
        VARIANTS[variant],
        size === "lg" ? "h-12 px-6 text-sm" : "h-9 px-4 text-sm",
        pending && "cursor-not-allowed opacity-80",
        className,
      )}
    >
      <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-[130%]" />
      <span className="relative inline-flex items-center gap-2">{children}</span>
    </motion.button>
  );
}
