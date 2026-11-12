import { useEffect, useState } from "react";

/**
 * Whether this is "Lanework (Preview)", a packaged dev build beside the
 * release (`channel.ts`): false until main has said, so nothing flickers
 * locked in the release.
 */
export function useIsPreview(): boolean {
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let gone = false;
    void window.desktop
      ?.getAppInfo()
      .then((info) => {
        if (!gone) setPreview(info.channel === "preview");
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  return preview;
}
