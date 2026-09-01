import { useEffect, useState } from 'react';

import { prefersReducedMotion } from './animations';

/** Tracks both the operating-system preference and Obsidian's in-app reduced-motion setting. */
export function useObsidianReducedMotion(): boolean {
  const [isReduced, setIsReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    const update = () => setIsReduced(prefersReducedMotion());
    const mediaQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    const observer = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(update);

    mediaQuery?.addEventListener('change', update);
    if (document.body) {
      observer?.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    update();

    return () => {
      mediaQuery?.removeEventListener('change', update);
      observer?.disconnect();
    };
  }, []);

  return isReduced;
}
