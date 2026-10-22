import { useLayoutEffect } from 'react';
import { suspendDocumentScroll } from '../navigation/document-scroll';

/** Give iOS the document scroll view while the phone reader is open. */
export function useDocumentReaderScroll(enabled: boolean, articleId: string | undefined) {
  useLayoutEffect(() => {
    if (!enabled || !articleId) return;
    const reader = document.querySelector<HTMLElement>('.pwa-reading-root .crate-reading-reader');
    if (!reader) return;
    // Return a list screen's document offset to it before the reader takes over.
    const resume = suspendDocumentScroll();
    const top = reader.scrollTop;
    reader.dataset.documentScroll = 'true';
    document.documentElement.classList.add('pwa-document-reader');
    window.scrollTo({ top, behavior: 'instant' });
    return () => {
      const top = window.scrollY;
      delete reader.dataset.documentScroll;
      document.documentElement.classList.remove('pwa-document-reader');
      window.scrollTo({ top: 0, behavior: 'instant' });
      // Keep the retained article at the same passage during its exit animation.
      reader.scrollTop = top;
      resume();
    };
  }, [enabled, articleId]);
}
