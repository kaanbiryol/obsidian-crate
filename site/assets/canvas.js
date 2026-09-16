// Canvas navigation. The interactive vault example has its own controller.
if (new URLSearchParams(window.location.search).has("embed")) {
  document.documentElement.classList.add("embed");
}
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
