// Canvas navigation and sticky header.
const header = document.querySelector('.canvas-header');
const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#main-navigation');
const navLinks = Array.from(navigation?.querySelectorAll('a') ?? []);
const sections = navLinks.map((link) => {
  const href = link.getAttribute('href');
  return href?.startsWith('#') ? document.getElementById(href.slice(1)) : null;
});

function closeMenu() {
  menuButton?.setAttribute('aria-expanded', 'false');
  navigation?.classList.remove('is-open');
}

menuButton?.addEventListener('click', () => {
  const expanded = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(expanded));
  navigation?.classList.toggle('is-open', expanded);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuButton?.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menuButton.focus();
  }
});

document.addEventListener('click', (event) => {
  if (event.target instanceof Node && !header?.contains(event.target)) closeMenu();
});

header?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
header?.addEventListener('focusout', (event) => {
  if (!(event.relatedTarget instanceof Node) || !header.contains(event.relatedTarget)) closeMenu();
});
window.matchMedia('(min-width: 1001px)').addEventListener('change', closeMenu);

// One underline slides to the current section's link; it appears in place
// rather than flying in from the edge, and measures again after resizing.
let indicatorLink;
navigation?.classList.add('uses-indicator');
function moveIndicator(link, remeasure) {
  if (!navigation || (link === indicatorLink && !remeasure)) return;
  navigation.classList.toggle('is-indicator-sliding', Boolean(link && indicatorLink && !remeasure));
  navigation.classList.toggle('has-indicator', Boolean(link));
  indicatorLink = link;
  if (!link) return;
  navigation.style.setProperty('--indicator-x', `${link.offsetLeft}px`);
  navigation.style.setProperty('--indicator-width', `${link.offsetWidth}px`);
}

let scrollPending = false;
function updateNavigation(remeasure = false) {
  const threshold = (header?.getBoundingClientRect().height ?? 76) + 50;
  let active = -1;
  sections.forEach((section, index) => {
    if (section && section.getBoundingClientRect().top <= threshold) active = index;
  });
  navLinks.forEach((link, index) => {
    if (index === active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  moveIndicator(navLinks[active], remeasure);
  header?.classList.toggle('is-scrolled', window.scrollY > 12);
  scrollPending = false;
}
window.addEventListener('scroll', () => {
  if (scrollPending) return;
  scrollPending = true;
  window.requestAnimationFrame(() => updateNavigation());
}, { passive: true });
window.addEventListener('resize', () => updateNavigation(true));
updateNavigation();

// Hold the last frame, then fade the video over its stationary phone backdrop.
document.querySelectorAll('.reminder-recording video, .notification-preview video').forEach((recording) => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isGalleryPreview = Boolean(recording.closest('a[data-gallery-video]'));
  const replayDelay = Number(recording.dataset.replayDelay) || 3000;
  let visible = false;
  let replayTimer;
  let replaying = false;
  recording.muted = true;
  recording.loop = false;

  const canAutoplay = () => visible && !document.hidden && !reducedMotion.matches && !document.querySelector('#media-viewer[open]');
  function cancelReplay() {
    window.clearTimeout(replayTimer);
    replayTimer = undefined;
    replaying = false;
    recording.classList.remove('is-restarting');
  }
  function play() {
    recording.play().catch(() => {
      cancelReplay();
      recording.controls = !isGalleryPreview;
    });
  }
  function updatePlayback() {
    // Gallery previews open the player; playback controls belong to that player.
    recording.controls = !isGalleryPreview && reducedMotion.matches;
    if (!canAutoplay()) {
      cancelReplay();
      recording.pause();
      return;
    }
    if (replaying) return;
    if (!recording.ended) {
      play();
      return;
    }
    if (replayTimer !== undefined) return;
    replayTimer = window.setTimeout(() => {
      replaying = true;
      recording.classList.add('is-restarting');
      replayTimer = window.setTimeout(() => {
        replayTimer = undefined;
        if (canAutoplay()) recording.currentTime = 0;
        else cancelReplay();
      }, 350);
    }, replayDelay);
  }
  recording.addEventListener('seeked', () => {
    if (!replaying) return;
    if (canAutoplay()) play();
    else cancelReplay();
  });
  recording.addEventListener('playing', () => {
    recording.classList.remove('is-restarting');
    replaying = false;
  });
  recording.addEventListener('ended', updatePlayback);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    updatePlayback();
  }).observe(recording);
  document.addEventListener('visibilitychange', updatePlayback);
  document.addEventListener('crate:gallerychange', updatePlayback);
  reducedMotion.addEventListener('change', updatePlayback);
  updatePlayback();
});

// Copy only the displayed setup text; keep it selectable if the clipboard is blocked.
document.querySelectorAll('[data-copy-target]').forEach((button) => {
  const target = document.getElementById(button.dataset.copyTarget);
  if (!target || !navigator.clipboard?.writeText) return;
  const feedback = button.closest('[data-copy-container]').querySelector('[data-copy-status]');
  const label = button.textContent;
  let resetTimer;
  button.hidden = false;
  button.addEventListener('click', async () => {
    window.clearTimeout(resetTimer);
    button.disabled = true;
    feedback.textContent = '';
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      button.textContent = 'Copied';
      feedback.textContent = 'Copied to clipboard.';
    } catch {
      button.textContent = label;
      feedback.textContent = 'Copy unavailable. Select the text and copy it manually.';
    } finally {
      button.disabled = false;
      resetTimer = window.setTimeout(() => {
        button.textContent = label;
        feedback.textContent = '';
      }, 4000);
    }
  });
});

// Reveal the notification banners once their stage scrolls into view.
document.querySelectorAll('.notify-stage').forEach((stage) => {
  if (!('IntersectionObserver' in window)) return;
  stage.classList.add('is-pending');
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    stage.classList.remove('is-pending');
    observer.disconnect();
  }, { threshold: 0.35 });
  observer.observe(stage);
});

// Rise sections into view as they scroll in. Content already on screen at load
// stays as it is, so nothing flashes or stays hidden if this never runs.
(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  const variants = {
    text: '.changelog-hero > *, .reminder-recording figcaption > *, .encryption-copy > *, .notify-intro > *, .reading-intro > *, .hosting-intro > *, .save-sources-title, .install-intro > *',
    media: '.recording-media',
    card: '.changelog-entry, .save-source, .feature-preview, .encryption-diagram, .encryption-flow > li, .notification-preview, .sync-map-hub, .sync-map-devices > div, .hosting-option, .install-steps > li',
    draw: '.sync-map-branches',
  };
  // Items entering together arrive one after another, in reading order.
  const observer = new IntersectionObserver((entries) => {
    entries.filter((entry) => entry.isIntersecting).forEach((entry, index) => {
      observer.unobserve(entry.target);
      entry.target.style.setProperty('--reveal-delay', `${Math.min(index, 6) * 90}ms`);
      entry.target.classList.add('is-revealed');
    });
  }, { rootMargin: '0px 0px -8% 0px' });

  const targets = Array.from(document.querySelectorAll(Object.values(variants).join(',')))
    .filter((target) => target.getBoundingClientRect().top >= window.innerHeight);
  targets.forEach((target) => {
    target.dataset.reveal = Object.keys(variants).find((variant) => target.matches(variants[variant]));
    // Hand the element back to its own styles once it has settled.
    target.addEventListener('animationend', function settle(event) {
      if (event.target !== target || event.pseudoElement) return;
      target.removeEventListener('animationend', settle);
      target.classList.remove('is-revealed');
      target.removeAttribute('data-reveal');
      target.style.removeProperty('--reveal-delay');
    });
    observer.observe(target);
  });
})();

// Track the pointer so card highlights follow it.
document.querySelectorAll('.hosting-option, .encryption-diagram').forEach((card) => {
  card.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    const bounds = card.getBoundingClientRect();
    card.style.setProperty('--glow-x', `${event.clientX - bounds.left}px`);
    card.style.setProperty('--glow-y', `${event.clientY - bounds.top}px`);
  });
});
