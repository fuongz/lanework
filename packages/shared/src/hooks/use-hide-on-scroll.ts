import { useEffect, useRef, useState } from "react";

/**
 * Header behavior for full-page scroll: hide when scrolling down past a
 * threshold, reveal on any scroll up. `scrolled` flags when past the very top
 * (for swapping a transparent header to a solid one).
 */
export function useHideOnScroll(threshold = 120) {
  const [hidden, setHidden] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    function onScroll() {
      const y = window.scrollY;
      setScrolled(y > 8);
      setHidden(y > lastY.current && y > threshold);
      lastY.current = y;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);

  return { hidden, scrolled };
}
