// Checks for the positional arguments an `invoke` handler receives.
//
// NOTE: Electron-free on purpose, so a handler file's argument parsing can be
// unit-tested without booting the app. Every channel takes `unknown[]` from a
// renderer this app does not trust; a handler states what it expects through
// these instead of writing its own copy of the same check. Adopted one handler
// file at a time, when that file is next edited (FE-82/D3).

/** The longest id, slug or key any channel takes. */
const MAX_ID = 200;

/** A tuple of `count` unknowns, so `const [a, b] = arity(args, 2)` is typed. */
type Args<
  Count extends number,
  Acc extends unknown[] = [],
> = Acc["length"] extends Count ? Acc : Args<Count, [...Acc, unknown]>;

/**
 * The arguments, exactly `count` of them.
 *
 * NOTE: An extra argument is refused, not ignored. A preload that sends one
 * more than main reads is a mismatch, and it should show up as an error on
 * the first call rather than as a value nobody looked at.
 *
 * @throws When there are more or fewer than `count`.
 */
export function arity<Count extends number>(
  args: unknown[],
  count: Count,
  message = "Wrong number of arguments",
): Args<Count> {
  if (args.length !== count) throw new Error(message);
  return args as Args<Count>;
}

/**
 * An opaque id: a non-blank string of at most 200 characters that is not
 * `.` or `..`, so it can never walk out of a folder it names a file in.
 *
 * @throws When `value` is not one.
 */
export function id(value: unknown, message = "A valid id is required"): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_ID ||
    value === "." ||
    value === ".."
  )
    throw new Error(message);
  return value;
}

/**
 * A project's slug as the renderer names it: a non-blank string of at most
 * 200 characters. Main resolves the project from it; it is never a path.
 *
 * @throws When `value` is not one.
 */
export function slug(
  value: unknown,
  message = "A project is required",
): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID)
    throw new Error(message);
  return value;
}

/**
 * An integer in `[min, max]`.
 *
 * @throws When `value` is not a number, not an integer, or out of range.
 */
export function int(
  value: unknown,
  min: number,
  max: number,
  message = "A whole number is required",
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(message);
  return value;
}

/**
 * One of a closed list, typed as that list's member.
 *
 * Pass the `as const` list the union is derived from, so a new member is
 * accepted here the moment it is added to the type.
 *
 * @throws When `value` is not in `list`.
 */
export function oneOf<const List extends readonly string[]>(
  value: unknown,
  list: List,
  message = "That value is not allowed",
): List[number] {
  if (typeof value !== "string" || !list.includes(value))
    throw new Error(message);
  return value;
}
