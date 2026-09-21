// Canvas navigation and sticky header.
const header = document.querySelector('.canvas-header');
const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#main-navigation');
const navLinks = Array.from(navigation?.querySelectorAll('a') ?? []);
const sections = navLinks.map((link) => document.querySelector(link.getAttribute('href')));

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

navLinks.forEach((link) => link.addEventListener('click', closeMenu));
window.matchMedia('(min-width: 851px)').addEventListener('change', closeMenu);

let scrollPending = false;
function updateNavigation() {
  const threshold = (header?.getBoundingClientRect().height ?? 76) + 50;
  let active = -1;
  sections.forEach((section, index) => {
    if (section && section.getBoundingClientRect().top <= threshold) active = index;
  });
  navLinks.forEach((link, index) => {
    if (index === active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  header?.classList.toggle('is-scrolled', window.scrollY > 12);
  scrollPending = false;
}
window.addEventListener('scroll', () => {
  if (scrollPending) return;
  scrollPending = true;
  window.requestAnimationFrame(updateNavigation);
}, { passive: true });
window.addEventListener('resize', updateNavigation);
updateNavigation();

// Hold the last frame, then fade through each replay instead of jumping to zero.
document.querySelectorAll('.reminder-recording video').forEach((recording) => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const replayDelay = Number(recording.dataset.replayDelay) || 3000;
  let visible = false;
  let replayTimer;
  let replaying = false;
  recording.muted = true;
  recording.loop = false;

  const canAutoplay = () => visible && !document.hidden && !reducedMotion.matches;
  function cancelReplay() {
    window.clearTimeout(replayTimer);
    replayTimer = undefined;
    replaying = false;
    recording.classList.remove('is-restarting');
  }
  function play() {
    recording.play().catch(() => {
      cancelReplay();
      recording.controls = true;
    });
  }
  function updatePlayback() {
    recording.controls = reducedMotion.matches;
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
