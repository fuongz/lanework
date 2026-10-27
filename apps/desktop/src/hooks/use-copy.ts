import { useEffect, useState } from "react";

/**
 * Put something on the clipboard and say so, briefly.
 *
 * The confirmation matters: a copy button that looks the same before and
 * after a press gets pressed twice, or trusted when the copy failed.
 *
 * @returns the key copied last (null once the confirmation times out), and
 *   the function that copies `value` under `key`.
 */
export function useCopy(): [
  string | null,
  (key: string, value: string) => void,
] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return [
    copied,
    (key, value) => {
      void navigator.clipboard.writeText(value).then(
        () => setCopied(key),
        // A clipboard that refuses is not worth an error banner over a card;
        // the button does not confirm, which is the honest signal.
        () => setCopied(null),
      );
    },
  ];
}
