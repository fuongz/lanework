/**
 * The default lanes, categories and tag cap, copied from the board's
 * `reviews-core`.
 *
 * ⚠️ Byte-for-byte the same keys, roles and prefixes. These are what the cloud
 * board's columns are CREATED from on the first push, so a difference here
 * would mean a card imported from this app lands in a lane whose key the CLI
 * never uses — the same card, two lanes, depending on who imported it.
 *
 * ⚠️ Their own module because two readers need them and one of them is upstream
 * of the other: the location rule ("which lane is this file in") is used by the
 * folder summary AND by the migration, and importing it from the migration
 * would make the two circular.
 */
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

/** Default tag cap. It travels so the cloud does not silently drop a fourth tag. */
export const TAG_MAX = 3;
