import { useEffect, useState } from "react";

/**
 * Put something on the clipboard and say so, briefly.
 *
 * ⚠️ The confirmation is the whole feature. A copy button that looks identical
 * before and after being pressed is one people press twice, and then paste
 * whatever was there before.
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
        // the button simply does not confirm, which is the honest signal.
        () => setCopied(null),
      );
    },
  ];
}
