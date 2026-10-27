// How long ago something happened, in words: a sentence's "8 days ago" and a
// row's "3d". Shared by every screen that dates something, so it lives in
// its own module rather than in the board's.

/**
 * "8 days ago", "just now" — an age written out, for prose.
 *
 * A second formatter beside {@link shortAge}, not a replacement for it. A lane
 * row has space for `3d` and nothing more, while an activity line is a
 * SENTENCE — "decio created the issue. 3d" does not read as one.
 * `Intl.RelativeTimeFormat` makes the wording follow the user's locale
 * instead of an English template.
 *
 * `now` is a parameter for the same reason it is on {@link shortAge}: a
 * function that reads the clock cannot be tested at the boundary where this
 * kind of formatter goes wrong.
 */
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const seconds = Math.round((now - at) / 1000);
  // Clock skew between this machine and the service can put an event a few
  // seconds in the future; "in 4 seconds" about something that just happened
  // is worse than rounding it to now.
  if (seconds < 45) return "just now";
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const scales: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of scales) {
    if (seconds >= size)
      return format.format(-Math.floor(seconds / size), unit);
  }
  return "just now";
}

/**
 * "2h", "3d", "just now" — the age of a card at a glance.
 *
 * `now` is a parameter rather than `Date.now()`. A function that reads the
 * clock cannot be tested at a boundary, and "1 day ago vs 23 hours ago" is
 * where this kind of formatter goes wrong.
 */
export function shortAge(iso: string | null, now: number): string {
  if (!iso) return "";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(days / 365)}y`;
}
