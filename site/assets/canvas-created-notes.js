import { element as el } from './canvas-demo-data.js';

// Add real serialized reminder blocks to the visible sample note, without
// replacing existing checkboxes or disturbing their keyboard focus.
export function syncCreatedNotes(desktop, tasks) {
  const created = tasks.filter((task) => task.created);
  const ids = new Set(created.map((task) => task.id));
  desktop.querySelectorAll('[data-created-task]').forEach((node) => {
    if (!ids.has(node.dataset.createdTask)) node.remove();
  });
  for (const task of created) {
    const note = desktop.querySelector(`#note-${task.project}`);
    let reading = note.querySelector(`.note-reading [data-created-task="${task.id}"]`);
    if (!reading) {
      reading = el('div', { class: 'created-reminder', 'data-created-task': task.id }, [
        el('label', { class: 'editor-task' }, [el('input', { type: 'checkbox', 'data-editor-task': task.id }), el('span', { class: 'created-task-title' })]),
        el('p', { class: 'editor-task-description', hidden: !task.description }, task.description),
      ]);
      note.querySelector('.note-reading').append(reading);
      note.querySelector('.note-source').append(el('div', { class: 'created-reminder', 'data-created-task': task.id }, [
        el('div', { class: 'markdown-task', 'data-note-task': task.id }),
        el('div', { class: 'source-metadata', hidden: !task.descriptionLine }, task.descriptionLine),
      ]));
    }
    reading.querySelector('.created-task-title').replaceChildren(task.title,
      ...(task.date ? [' ', el('time', {}, task.date)] : []), ...(task.repeat ? [` · ${task.repeat}`] : []), ...(task.priority === 1 ? [' !'] : []));
    const line = note.querySelector(`[data-note-task="${task.id}"]`);
    const markerStart = task.sourceLine.indexOf(' <!--');
    const titleAndDate = task.sourceLine.slice(6, markerStart < 0 ? undefined : markerStart);
    line.replaceChildren(el('span', {}, task.completed ? '- [x]' : '- [ ]'), ` ${titleAndDate}`,
      ...(markerStart < 0 ? [] : [' ', el('span', { class: 'source-metadata' }, task.sourceLine.slice(markerStart + 1))]));
  }
}
