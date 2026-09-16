import { initialReminders, projects } from './canvas-demo-data.js';
import { createReminderDemo } from './canvas-reminders.js';
import { syncCreatedNotes } from './canvas-created-notes.js';

// A local sample vault; interactions never read or write the visitor's files.
const desktop = document.querySelector('.canvas-stage');
const editorTabs = Array.from(desktop.querySelectorAll('.mac-note-tabs [role="tab"]'));
const editorNotes = Array.from(desktop.querySelectorAll('.editor-note'));
const editorMode = desktop.querySelector('.editor-mode');
const reset = desktop.querySelector('.reset-demo');
const feedback = desktop.querySelector('#demo-feedback');
const initialNote = editorTabs.find((tab) => tab.getAttribute('aria-selected') === 'true').dataset.note;
const noteHistory = [initialNote];
let historyPosition = 0;

function syncNotes(tasks, changed) {
  syncCreatedNotes(desktop, tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  desktop.querySelectorAll('[data-editor-task]').forEach((input) => {
    const task = byId.get(input.dataset.editorTask);
    input.checked = task.completed;
    input.setAttribute('aria-label', `${task.completed ? 'Reopen' : 'Complete'} ${task.title} from the note`);
  });
  desktop.querySelectorAll('[data-note-task]').forEach((line) => {
    const task = byId.get(line.dataset.noteTask);
    const completed = task.completed;
    if (!task.created && task.dueDatetime) line.querySelector('mark').textContent = task.dueDatetime;
    line.classList.toggle('is-complete', completed);
    line.querySelector('span').textContent = completed ? '- [x]' : '- [ ]';
  });
  const visibleNote = desktop.querySelector('.editor-note:not([hidden]) .note-reading');
  desktop.querySelector('#note-word-count').textContent = `${visibleNote.textContent.trim().split(/\s+/).length} words`;
  reset.disabled = tasks.length === initialReminders.length && tasks.every((task) => task.completed === Boolean(initialReminders.find((item) => item.id === task.id)?.completed));
  if (changed) feedback.textContent = changed.rescheduled ? `${changed.title} completed. Next: ${changed.date}.` : `${changed.title} ${changed.completed ? 'completed' : 'reopened'}. The example note is updated.`;
}

const reminders = createReminderDemo(desktop.querySelector('.demo-app'), {
  onProjectSelect: (id) => showNote(id, true, false),
  onChange: syncNotes,
});

function revealTab(selected) {
  const strip = selected.parentElement;
  const left = selected.offsetLeft - strip.offsetLeft;
  if (left < strip.scrollLeft) strip.scrollLeft = left;
  else if (left + selected.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + selected.offsetWidth - strip.clientWidth;
}

function showNote(id, addToHistory = true, syncSidebar = true) {
  const selected = editorTabs.find((tab) => tab.dataset.note === id);
  if (!selected) return;
  editorTabs.forEach((tab) => {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  editorNotes.forEach((note) => { note.hidden = note.id !== `note-${id}`; });
  desktop.querySelectorAll('.canvas-files [data-open-note]').forEach((file) => {
    const active = file.dataset.openNote === id;
    file.classList.toggle('selected', active);
    if (active) file.setAttribute('aria-current', 'page');
    else file.removeAttribute('aria-current');
  });
  revealTab(selected);
  desktop.querySelector('.editor-document-name').textContent = selected.textContent;
  desktop.querySelector('.editor-scroll').scrollTop = 0;
  const words = desktop.querySelector(`#note-${id} .note-reading`).textContent.trim().split(/\s+/).length;
  desktop.querySelector('#note-word-count').textContent = `${words} words`;
  if (addToHistory && noteHistory[historyPosition] !== id) {
    noteHistory.splice(historyPosition + 1);
    noteHistory.push(id);
    historyPosition = noteHistory.length - 1;
  }
  desktop.querySelector('[data-history="back"]').disabled = historyPosition === 0;
  desktop.querySelector('[data-history="forward"]').disabled = historyPosition === noteHistory.length - 1;
  if (syncSidebar) reminders.selectNote(id);
}

window.addEventListener('resize', () => revealTab(editorTabs.find((tab) => tab.getAttribute('aria-selected') === 'true')));
desktop.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('[data-open-note],.mac-note-tabs [data-note]');
  if (button) {
    const id = button.dataset.openNote ?? button.dataset.note;
    const fromNote = Boolean(button.closest('.editor-note'));
    showNote(id);
    if (fromNote) desktop.querySelector(`#note-${id}`).focus({ preventScroll: true });
  }
});
editorTabs.forEach((tab, index) => {
  tab.addEventListener('keydown', (event) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % editorTabs.length : event.key === 'ArrowLeft' ? (index + editorTabs.length - 1) % editorTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? editorTabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    showNote(editorTabs[next].dataset.note);
    editorTabs[next].focus({ preventScroll: true });
  });
});
desktop.querySelectorAll('[data-history]').forEach((button) => {
  button.addEventListener('click', () => {
    historyPosition += button.dataset.history === 'back' ? -1 : 1;
    showNote(noteHistory[historyPosition], false);
  });
});
editorMode.addEventListener('click', () => {
  const source = editorMode.getAttribute('aria-pressed') !== 'true';
  editorMode.setAttribute('aria-pressed', String(source));
  editorMode.setAttribute('aria-label', source ? 'Show reading view' : 'Show Markdown source');
  editorMode.setAttribute('title', source ? 'Show reading view' : 'Show Markdown source');
  editorNotes.forEach((note) => {
    note.querySelector('.note-source').hidden = !source;
    note.querySelector('.note-reading').hidden = source;
  });
});
desktop.addEventListener('change', (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.dataset.editorTask) reminders.setCompleted(input.dataset.editorTask, input.checked);
});
let composer;
let loadingComposer = false;
desktop.querySelector('.app-fab').addEventListener('click', async () => {
  if (loadingComposer) return;
  const button = desktop.querySelector('.app-fab');
  loadingComposer = true;
  button.setAttribute('aria-busy', 'true');
  try {
    if (!composer) {
      const { createComposer } = await import('./canvas-composer.generated.js');
      composer = createComposer({ projects, onAdd(task, complete) {
        reminders.add(task, complete);
        showNote(task.project);
        desktop.querySelector(`[data-editor-task="${task.id}"]`)?.scrollIntoView({ block: 'nearest' });
        feedback.textContent = `${task.title} added to ${projects.find((project) => project.id === task.project).name}. The example Markdown is updated.`;
      } });
    }
    composer.open(reminders.getSelectedProject());
  } catch {
    feedback.textContent = 'The example editor could not load. Refresh the page and try again.';
  } finally {
    loadingComposer = false;
    button.removeAttribute('aria-busy');
  }
});
reset.addEventListener('click', () => {
  composer?.close();
  reminders.reset();
  feedback.textContent = 'Example reset. Explore the notes or try completing a reminder.';
});
showNote(initialNote);
syncNotes(reminders.getTasks());
