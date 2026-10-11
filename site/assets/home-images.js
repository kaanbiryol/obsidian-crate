// Keep native lazy loading as a fallback, but prepare nearby screenshots early.
(() => {
  const preloadObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.loading = 'eager';
        preloadObserver.unobserve(entry.target);
      });
    }, { rootMargin: '1600px 0px' })
    : null;

  document.querySelectorAll('.product-image img[loading="lazy"]').forEach((image) => {
    // Cached images can stay visible immediately, without flashing or fading again.
    if (image.complete) return;

    image.classList.add('is-loading');
    async function reveal() {
      image.removeEventListener('load', reveal);
      image.removeEventListener('error', reveal);
      preloadObserver?.unobserve(image);
      try {
        if (image.naturalWidth > 0) await image.decode();
      } catch {
        // Decoding failures must not leave the image or its alt text hidden.
      } finally {
        image.classList.remove('is-loading');
      }
    }
    image.addEventListener('load', reveal, { once: true });
    image.addEventListener('error', reveal, { once: true });
    preloadObserver?.observe(image);
    if (image.complete) void reveal();
  });
})();
