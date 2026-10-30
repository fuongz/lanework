// The default lanes, categories and tag cap, copied from the board's
// `reviews-core`.
//
// NOTE: Keep the keys, roles and prefixes byte-for-byte the same. The cloud
// board's columns are created from them on the first push. A difference would
// put a card imported from this app in a lane whose key the CLI never uses:
// the same card, two lanes, depending on who imported it.
//
// They have their own module because two readers need them and one is upstream
// of the other. The location rule ("which lane is this file in") serves the
// folder summary and the migration, and importing it from the migration would
// make the two circular.

/** The default board lanes, in board order. */
export const DEFAULT_COLUMNS = [
  {
    key: "backlog",
    name: "Backlog",
    role: "intake",
    icon: "idea",
    tone: "violet",
  },
  {
    key: "todo",
    name: "To-Do",
    role: "start",
    icon: "circle-dashed",
    tone: "amber",
  },
  {
    key: "processing",
    name: "In Progress",
    role: "active",
    icon: "progress",
    tone: "blue",
  },
  { key: "done", name: "Done", role: "done", icon: "check", tone: "emerald" },
  {
    key: "dropped",
    name: "Archived",
    role: "archive",
    icon: "archive",
    tone: "neutral",
  },
] as const;

const TASK_ID_FORMAT = "{prefix}-{seq}";
const TASK_ID_PAD = 2;

export const DEFAULT_CATEGORIES = [
  {
    key: "product-design",
    name: "Product Design",
    prefix: "PD",
    tone: "violet",
  },
  { key: "frontend", name: "Frontend", prefix: "FE", tone: "sky" },
  { key: "backend", name: "Backend", prefix: "BE", tone: "emerald" },
  {
    key: "infrastructure",
    name: "Infrastructure",
    prefix: "INF",
    tone: "amber",
  },
  { key: "documentation", name: "Documentation", prefix: "DOC", tone: "teal" },
].map((category) => ({
  ...category,
  format: TASK_ID_FORMAT,
  pad: TASK_ID_PAD,
}));

/** The default tag cap. It travels so the cloud does not drop a fourth tag. */
export const TAG_MAX = 3;
