// Canvas-specific navigation and the local Markdown demonstration.
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

const demo = document.querySelector('.demo-app');
const reset = document.querySelector('.reset-demo');
const feedback = document.querySelector('#demo-feedback');

function updateMarkdown() {
  const completed = new Set(Array.from(demo?.querySelectorAll('input[data-task]:checked') ?? [])
    .map((input) => input.dataset.task));
  document.querySelectorAll('[data-note-task]').forEach((note) => {
    const done = completed.has(note.dataset.noteTask);
    note.classList.toggle('is-complete', done);
    const marker = note.querySelector('span');
    if (marker) marker.textContent = done ? '- [x]' : '- [ ]';
  });
  demo?.querySelectorAll('[data-project]').forEach((project) => {
    const remaining = project.dataset.project.split(',').filter((task) => !completed.has(task)).length;
    project.querySelector('small').textContent = `${remaining} ${remaining === 1 ? 'reminder' : 'reminders'}`;
  });
  if (reset instanceof HTMLButtonElement) reset.disabled = completed.size === 0;
}

demo?.addEventListener('change', (event) => {
  if (!(event.target instanceof HTMLInputElement) || !event.target.dataset.task) return;
  updateMarkdown();
  const title = event.target.closest('.reminder-card')?.querySelector('strong')?.textContent ?? 'Reminder';
  if (feedback) feedback.textContent = event.target.checked
    ? `${title} completed. The example Markdown is updated.`
    : `${title} reopened. The example Markdown is updated.`;
});

reset?.addEventListener('click', () => {
  demo?.querySelectorAll('input[data-task]').forEach((input) => { input.checked = false; });
  // Shared demo controls own the tab counts and duplicate reminder state.
  demo?.querySelector('input[data-task]')?.dispatchEvent(new Event('change', { bubbles: true }));
  if (feedback) feedback.textContent = 'Example reset. Complete a reminder to see its Markdown update.';
});
