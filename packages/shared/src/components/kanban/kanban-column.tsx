import { motion, AnimatePresence } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReviewCard } from "@/lib/github";
import type { StatusMeta } from "@/lib/review-status";
import { cn } from "@/lib/utils";
import { KanbanCard } from "./kanban-card";

export function KanbanColumn({
  meta,
  cards,
  index = 0,
}: {
  meta: StatusMeta;
  cards: ReviewCard[];
  index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.07, ease: [0.22, 1, 0.36, 1] }}
      className="flex h-full w-80 shrink-0 flex-col rounded-2xl bg-muted/40"
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <HugeiconsIcon icon={meta.icon} className={cn("size-4", meta.color)} />
        <h2 className="text-sm font-medium text-foreground">{meta.label}</h2>
        <span className="text-sm text-muted-foreground">{cards.length}</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2.5 pb-2.5 pt-0.5">
        {cards.length === 0 ? (
          <p className="rounded-xl border border-dashed py-8 text-center text-xs text-muted-foreground">
            No reviews
          </p>
        ) : (
          <AnimatePresence mode="popLayout">
            {cards.map((card) => (
              <motion.div
                key={card.path}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                whileHover={{ y: -3 }}
              >
                <KanbanCard card={card} />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </motion.div>
  );
}
