import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeIconProvider } from '../../src/reminders/components/theme-icon';
import { PwaThemeIcon } from '../../src/pwa/components/PwaThemeIcon';
import { ReminderEditorScreen } from '../../src/pwa/components/ReminderEditorScreen';
import { ReminderPickerSheet } from '../../src/pwa/components/ReminderPickerSheet';
import { buildReminderMutationBody } from '../../src/pwa/reminder-mutation';
import { buildCreatedReminderBlock, buildReminderCompletionPlan } from '../../src/reminders/core/markdownReminderMutation';
import { buildDescriptionBlock } from '../../src/reminders/core/markdownReminderFile';
import { parseReminderDateValue } from '../../src/reminders/utils/reminderDate';
import { formatDueDate } from '../../src/reminders/utils/dateFormatting';
import { formatRecurrence } from '../../src/reminders/utils/rruleConverter';

function presentation(task) {
  const date = parseReminderDateValue(task.dueDatetime || task.dueDate, Boolean(task.dueDatetime));
  const now = new Date();
  const day = date ? Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000) : null;
  return { ...task, day, time: date && task.dueDatetime ? date.getHours() + date.getMinutes() / 60 : 0,
    date: formatDueDate(task.dueDatetime || task.dueDate) || '', repeat: task.recurrence ? formatRecurrence(task.recurrence) : '' };
}

export function completeCreatedReminder(task, completed) {
  const plan = buildReminderCompletionPlan({ ...task, content: task.title, rawLine: task.sourceLine, filePath: '', lineNumber: 0 }, completed);
  return presentation({ ...task, completed: plan.completed, dueDate: plan.dueDate, dueDatetime: plan.dueDatetime,
    recurrence: plan.recurrence, sourceLine: plan.checkboxLine, rescheduled: Boolean(plan.recurringInstanceCompleted) });
}

function createTask(modal, projects) {
  const input = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, draft: modal.draft, mode: 'create',
    projects: projects.map((project) => project.name), selectedProject: modal.draft.project });
  if (!input.content.trim()) throw new Error('Add a reminder title first.');
  const project = projects.find((item) => item.name === input.project);
  if (!project) throw new Error('Choose one of the example projects.');
  const id = crypto.randomUUID();
  const mutation = buildCreatedReminderBlock({ content: input.content, description: input.description || undefined,
    dueDate: parseReminderDateValue(input.dueDatetime || input.dueDate, Boolean(input.dueDatetime)),
    hasTime: input.recurrence && !input.dueDate && !input.dueDatetime ? undefined : Boolean(input.dueDatetime),
    recurrence: input.recurrence, priority: input.priority, reminderId: id });
  return presentation({ id, project: project.id, title: input.content, description: mutation.description || '',
    priority: mutation.priority, recurrence: mutation.recurrence, dueDate: mutation.dueDateKey, dueDatetime: mutation.dueDatetime,
    completed: false, created: true, sourceLine: mutation.checkboxLine, descriptionLine: buildDescriptionBlock(mutation.description)[0] || '' });
}

function Composer({ projects, defaultProject, onAdd, onClose }) {
  const names = projects.map((project) => project.name);
  const [modal, setModal] = useState({ mode: 'create', draft: { content: '', description: '', defaultProject,
    project: defaultProject, priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false } });
  const [error, setError] = useState('');
  const [focusRequest, setFocusRequest] = useState(0);
  const activeDialog = useRef(null);
  const patch = useCallback((update) => setModal((current) => ({ ...current, draft: { ...current.draft, ...update } })), []);
  const picker = modal.draft.activePicker;
  const closePicker = useCallback((update = {}) => {
    // Inbox has no inline project token, so use it as the fallback once selected.
    patch({ ...update, ...(update.project === 'Inbox' ? { defaultProject: 'Inbox' } : {}), activePicker: null });
    setFocusRequest((value) => value + 1);
  }, [patch]);
  useEffect(() => {
    if (picker) activeDialog.current?.focus({ preventScroll: true });
  }, [picker]);
  function save(current) {
    try { onAdd(createTask(current, projects), completeCreatedReminder); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add the example. Try again.'); }
  }
  function keyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (picker) closePicker(); else onClose();
    }
  }
  const tryExample = () => {
    const { project, defaultProject: fallbackProject, priority } = modal.draft;
    const content = ['Review launch notes tomorrow at 9am', project !== fallbackProject ? `#${project}` : '', priority === 1 ? '!' : ''].filter(Boolean).join(' ');
    patch({ content });
    setFocusRequest((value) => value + 1);
  };
  return h(ThemeIconProvider, { renderer: PwaThemeIcon }, h('div', { className: 'pwa-modal-sheet', onKeyDown: keyDown }, [
    h('div', { key: 'editor', hidden: Boolean(picker) }, h(ReminderEditorScreen, {
      modal, colorScheme: 'dark', projectOptions: names, saving: false, isClosing: false,
      isActive: !picker, isReturningToEditor: false, canInteract: !picker, editorFocusRequest: focusRequest,
      dialogRef: (node) => { if (!picker) activeDialog.current = node; }, onPatchDraft: patch,
      onOpenPicker: (activePicker) => patch({ activePicker }), onClose, onSave: save, onDelete: () => {},
    })),
    picker && h(ReminderPickerSheet, { key: picker, isDark: true, draft: modal.draft, projectOptions: names,
      dialogRef: (node) => { activeDialog.current = node; }, onPatch: patch, onSelect: closePicker, onClose: () => closePicker() }),
    error && h('p', { key: 'error', role: 'alert', className: 'canvas-composer-error' }, error),
    !picker && h('div', { key: 'hint', className: 'canvas-composer-intro' }, [
      'Try: ', h('button', { type: 'button', onClick: tryExample }, 'Review launch notes tomorrow at 9am'),
      h('br'), 'Adds to this example vault. Reset example clears your additions.',
    ]),
  ]));
}

export function createComposer({ projects, onAdd }) {
  let dialog;
  let root;
  let returnFocus;
  function close() {
    if (!dialog) return;
    dialog.close(); root.unmount(); dialog.remove(); dialog = null;
    if (returnFocus?.isConnected && !returnFocus.hidden) returnFocus.focus({ preventScroll: true });
  }
  return {
    open(projectId = 'inbox') {
      if (dialog) return;
      returnFocus = document.activeElement;
      dialog = document.createElement('dialog');
      dialog.className = 'canvas-composer crate-reminders-ui';
      dialog.setAttribute('aria-label', 'Example reminder composer');
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
      dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
      document.body.append(dialog);
      root = createRoot(dialog);
      root.render(h(Composer, { projects, defaultProject: projects.find((project) => project.id === projectId)?.name || 'Inbox', onAdd, onClose: close }));
      dialog.showModal();
    },
    close,
  };
}
