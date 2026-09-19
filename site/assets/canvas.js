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
window.matchMedia('(min-width: 601px)').addEventListener('change', closeMenu);

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

// Keep every screenshot readable without JavaScript; enhance to keyboard-accessible tabs.
document.querySelectorAll('[data-gallery]').forEach((gallery, galleryIndex) => {
  const panels = Array.from(gallery.querySelectorAll(':scope > figure'));
  const tabs = document.createElement('div');
  tabs.className = 'gallery-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', gallery.dataset.gallery);
  const buttons = panels.map((panel, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = panel.dataset.label;
    button.id = `gallery-${galleryIndex}-tab-${index}`;
    panel.id = `gallery-${galleryIndex}-panel-${index}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    tabs.append(button);
    return button;
  });
  function select(index, focus = false) {
    panels.forEach((panel, i) => {
      panel.hidden = i !== index;
      buttons[i].setAttribute('aria-selected', String(i === index));
      buttons[i].tabIndex = i === index ? 0 : -1;
    });
    if (focus) buttons[index].focus();
  }
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => select(index));
    button.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % panels.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + panels.length) % panels.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = panels.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      select(next, true);
    });
  });
  gallery.prepend(tabs);
  gallery.classList.add('is-enhanced');
  select(0);
});
