import { motion } from "motion/react";
import { useHideOnScroll } from "@/hooks/use-hide-on-scroll";
import { Wordmark } from "./wordmark";
import { cn } from "@/lib/utils";

/** Fixed marketing header that hides on scroll-down and reveals on scroll-up. */
export function SiteHeader({
  center,
  actions,
}: {
  center?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const { hidden, scrolled } = useHideOnScroll();
  return (
    <motion.header
      animate={{ y: hidden ? "-110%" : "0%" }}
      transition={{ duration: 0.3, ease: "easeInOut" }}
      className={cn(
        "fixed inset-x-0 top-0 z-40 border-b transition-colors duration-300",
        scrolled
          ? "border-border/60 bg-background/80 shadow-sm backdrop-blur-md"
          : "border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Wordmark />
        {center}
        <div className="flex items-center gap-2">{actions}</div>
      </div>
    </motion.header>
  );
}
