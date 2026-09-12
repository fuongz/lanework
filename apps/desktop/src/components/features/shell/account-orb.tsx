import { type CSSProperties, useMemo } from "react";
import { cn } from "#/lib/utils";

/** FNV-1a. Small, stable, and dependency-free — all this needs. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic stream of 0–1 values from one seed (xorshift32). */
function stream(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Where the four blooms sit, one per quadrant, before jitter.
 *
 * Fixed rather than random: four positions drawn freely cluster often enough
 * that some accounts would get a flat, one-colour disc. The jitter below is
 * what makes them individual; this is what keeps them all readable.
 */
const SPOTS = [
  [22, 18],
  [78, 22],
  [70, 82],
  [20, 78],
] as const;

/** Hue offsets from the seed's base, in degrees. */
const HUES = [0, 55, 150, 250] as const;

function orb(seed: string): CSSProperties {
  const next = stream(hash(seed));
  const base = next() * 360;

  const layers = SPOTS.map(([x, y], i) => {
    // ⚠️ Both stops are the SAME colour, the outer one at alpha 0 — never the
    // keyword `transparent`. That keyword is transparent BLACK, and fading a
    // pastel to it drags every blend through grey, which is exactly the muddy
    // ring this look cannot have.
    const hue = base + HUES[i] + (next() * 24 - 12);
    const light = 0.84 + next() * 0.08;
    const chroma = 0.07 + next() * 0.07;
    const size = 95 + next() * 40;
    const cx = x + (next() * 20 - 10);
    const cy = y + (next() * 20 - 10);
    const color = (alpha: number) =>
      `oklch(${light} ${chroma} ${hue} / ${alpha})`;
    return `radial-gradient(${size}% ${size}% at ${cx}% ${cy}%, ${color(1)} 0%, ${color(0)} 62%)`;
  });

  // A pale bloom low and centre, the way light sits in the reference: it keeps
  // the middle from turning into whichever two blooms happen to overlap there.
  layers.push(
    `radial-gradient(62% 58% at 50% 62%, oklch(0.98 0.015 ${base} / 0.55) 0%, oklch(0.98 0.015 ${base} / 0) 72%)`,
  );

  return {
    backgroundColor: `oklch(0.95 0.02 ${base})`,
    backgroundImage: layers.join(", "),
    // A hairline of its own, because the palest orbs are nearly the colour of a
    // light sidebar and would otherwise have no edge at all.
    boxShadow: "inset 0 0 0 1px oklch(0 0 0 / 0.07)",
  };
}

/**
 * The account's mark: a soft gradient orb, generated from who you are.
 *
 * Same seed, same orb, forever — so it works the way a face does, recognised
 * rather than read. It replaced two characters sliced off the raw `userId`,
 * which looked like initials and was not: an opaque id's first two characters
 * say nothing about the person holding it.
 */
export function AccountOrb({
  seed,
  className,
}: {
  seed: string;
  className?: string;
}) {
  const style = useMemo(() => orb(seed), [seed]);
  return (
    <span
      aria-hidden="true"
      className={cn("shrink-0 rounded-full", className)}
      style={style}
    />
  );
}
