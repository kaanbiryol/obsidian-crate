import { projects, initialReminders, element as el, icon } from './canvas-demo-data.js';

// Match the real PWA's view filtering, completed groups, and project progress.
export function createReminderDemo(app, { onProjectSelect, onChange }) {
  let reminders = initialReminders.map((task) => ({ ...task, completed: Boolean(task.completed) }));
  let view = 'inbox';
  let selectedProject = null;
  let completeCreated;
  const expanded = new Set();
  const tabs = Array.from(app.querySelectorAll('[role="tab"]'));
  const panel = app.querySelector('[role="tabpanel"]');
  const fab = app.querySelector('.app-fab');
  const key = () => selectedProject ? `project:${selectedProject}` : view;
  const progress = (tasks) => tasks.length ? Math.round(tasks.filter((task) => task.completed).length / tasks.length * 100) : 0;

  function stats(tasks) {
    const done = tasks.filter((task) => task.completed).length;
    return el('span', { class: 'pwa-project-stats' }, [
      el('span', { class: 'pwa-active-stat' }, [icon('circle'), `${tasks.length - done} active`]),
      done > 0 && el('span', { class: 'pwa-done-stat' }, [icon('obsidian-reminders'), `${done} done`]),
    ]);
  }

  function meter(tasks, name) {
    const value = progress(tasks);
    return el('span', { class: `pwa-progress ${value === 100 ? 'is-done' : ''}` }, [
      el('progress', { max: 100, value, 'aria-label': `${name} completion` }), el('span', {}, `${value}%`),
    ]);
  }

  function card(task) {
    const project = projects.find((item) => item.id === task.project);
    const tags = [
      !task.completed && task.priority === 1 && el('span', { class: 'tag tag-priority', 'aria-label': 'Important' }, [icon('flag'), 'Important']),
      task.repeat && el('span', { class: 'tag tag-repeat' }, [icon('repeat'), task.repeat]),
      task.date && el('span', { class: 'tag tag-date' }, [icon('today'), task.date]),
      !selectedProject && el('span', { class: `tag pwa-project-tag project-${project.id}` }, [icon('projects'), project.name]),
    ].filter(Boolean);
    return el('article', { class: `reminder-card ${task.completed ? 'is-completed' : ''}` }, [
      el('input', { type: 'checkbox', 'data-task': task.id, 'aria-label': `Mark ${task.title} ${task.completed ? 'incomplete' : 'complete'}`, checked: task.completed }),
      el('span', { class: 'reminder-body' }, [
        el('strong', {}, task.title),
        !task.completed && task.description && el('span', { class: 'reminder-description' }, task.description),
        tags.length > 0 && el('span', { class: 'reminder-tags' }, tags),
      ]),
    ]);
  }

  function renderTasks(tasks) {
    const active = tasks.filter((task) => !task.completed);
    const completed = tasks.filter((task) => task.completed);
    const content = [];
    if (view === 'upcoming') {
      for (const day of [...new Set(active.map((task) => task.day))]) {
        const date = new Date();
        date.setDate(date.getDate() + day);
        const label = day === 0 ? 'Today' : day === 1 ? 'Tomorrow' : date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        content.push(el('section', { class: 'pwa-date-group', 'aria-label': label }, [
          el('h4', {}, label), el('div', { class: 'pwa-task-list' }, active.filter((task) => task.day === day).map(card)),
        ]));
      }
    } else content.push(el('div', { class: 'pwa-task-list' }, active.map(card)));
    if (!tasks.length) content.push(el('div', { class: 'project-inbox-empty' }, [
      el('strong', {}, view === 'today' ? 'No reminders for today' : 'No reminders'),
      el('p', {}, view === 'upcoming' ? 'Nothing scheduled for the next few days.' : 'You’re all caught up.'),
    ]));
    if (completed.length && view !== 'upcoming') {
      content.push(el('details', { class: 'pwa-completed', open: expanded.has(key()) }, [
        el('summary', {}, [`Completed (${completed.length})`, icon('chevron')]),
        el('div', { class: 'pwa-task-list' }, completed.map(card)),
      ]));
    }
    return content;
  }

  function renderProjectRows() {
    return projects.map((project) => {
      const tasks = reminders.filter((task) => task.project === project.id);
      return el('button', { type: 'button', class: `pwa-project-row project-${project.id}`, 'data-open-project': project.id, 'aria-label': `Open ${project.name} project` }, [
        el('i', { class: 'pwa-project-strip' }),
        el('span', { class: 'pwa-project-copy' }, [
          el('strong', {}, project.name),
          progress(tasks) === 100 ? el('span', { class: 'pwa-project-stats' }, el('span', { class: 'pwa-done-stat' }, 'All done')) : stats(tasks),
        ]), meter(tasks, project.name), icon('chevron'),
      ]);
    });
  }

  function render() {
    const project = projects.find((item) => item.id === selectedProject);
    let tasks = reminders;
    if (project) tasks = reminders.filter((task) => task.project === project.id);
    else if (view === 'inbox') tasks = reminders.filter((task) => task.project === 'inbox');
    else if (view === 'today') tasks = reminders.filter((task) => task.day !== null && (task.completed ? task.day === 0 : task.day <= 0));
    else if (view === 'upcoming') tasks = reminders.filter((task) => task.day !== null && !task.completed && (task.day > 0 || (task.day === 0 && task.time > 0))); 
    if (view === 'today' || view === 'upcoming') tasks = [...tasks].sort((a, b) => a.day - b.day || a.time - b.time);
    const count = tasks.filter((task) => !task.completed).length;
    const title = view === 'inbox' ? 'Inbox' : view === 'today' ? 'Today' : view === 'upcoming' ? 'Upcoming' : 'Projects';
    const label = view === 'projects' ? `${projects.length} projects` : `${count} ${count === 1 ? 'reminder' : 'reminders'}`;
    const heading = project ? el('div', { class: `pwa-project-header project-${project.id}` }, [
      el('button', { class: 'pwa-project-back', type: 'button' }, [icon('chevron'), 'Projects']),
      el('h3', {}, project.name), el('div', { class: 'pwa-project-meta' }, [stats(tasks), meter(tasks, project.name)]),
    ]) : el('div', { class: 'app-heading' }, [
      el('div', {}, [el('h3', {}, title), el('p', { class: 'app-count' }, label)]),
      el('div', { class: 'app-heading-actions', 'aria-hidden': 'true' }, [
        el('span', { class: 'app-icon' }, icon('settings')),
      ]),
    ]);
    const body = view === 'projects' && !project ? el('div', { class: 'pwa-project-list' }, renderProjectRows()) : renderTasks(tasks);
    const oldScroll = panel.querySelector('.pwa-scroll')?.scrollTop ?? 0;
    panel.replaceChildren(heading, el('div', { class: 'pwa-scroll' }, body));
    panel.querySelector('.pwa-scroll').scrollTop = oldScroll;
    panel.setAttribute('aria-labelledby', `canvas-tab-${view}`);
    fab.hidden = view === 'projects' && !project;
    tabs.forEach((tab) => {
      const active = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panel.querySelector('.pwa-completed')?.addEventListener('toggle', (event) => {
      if (!event.target.isConnected) return;
      if (event.target.open) expanded.add(key());
      else expanded.delete(key());
    });
  }

  function selectView(next) {
    view = next;
    selectedProject = null;
    render();
    panel.querySelector('.pwa-scroll').scrollTop = 0;
  }

  function setCompleted(id, completed, fromSidebar = false) {
    const task = reminders.find((item) => item.id === id);
    if (!task) return;
    if (task.created) Object.assign(task, completeCreated(task, completed));
    else task.completed = completed;
    render();
    onChange(reminders, task);
    if (fromSidebar) {
      const target = task.completed ? panel.querySelector('.pwa-completed summary') ?? panel.querySelector('input') : panel.querySelector(`input[data-task="${id}"]`);
      (target ?? tabs.find((tab) => tab.dataset.view === view))?.focus({ preventScroll: true });
    }
  }

  app.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.dataset.task) setCompleted(event.target.dataset.task, event.target.checked, true);
  });
  panel.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const project = event.target.closest('[data-open-project]');
    if (project) {
      view = 'projects';
      selectedProject = project.dataset.openProject;
      render();
      panel.querySelector('.pwa-scroll').scrollTop = 0;
      onProjectSelect(selectedProject);
      panel.querySelector('.pwa-project-back').focus({ preventScroll: true });
    }
    if (event.target.closest('.pwa-project-back')) {
      const previousProject = selectedProject;
      selectView('projects');
      panel.querySelector(`[data-open-project="${previousProject}"]`)?.focus({ preventScroll: true });
    }
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectView(tab.dataset.view));
    tab.addEventListener('keydown', (event) => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      selectView(tabs[next].dataset.view);
      tabs[next].focus();
    });
  });
  render();
  return {
    setCompleted,
    add(task, complete) {
      completeCreated = complete;
      reminders.push(task);
      render();
      onChange(reminders);
    },
    getSelectedProject: () => selectedProject || 'inbox',
    selectNote(id) {
      if (!projects.some((project) => project.id === id)) return;
      if (id === 'inbox') return selectView('inbox');
      view = 'projects';
      selectedProject = id;
      render();
      panel.querySelector('.pwa-scroll').scrollTop = 0;
    },
    reset() {
      reminders = initialReminders.map((task) => ({ ...task, completed: Boolean(task.completed) }));
      expanded.clear();
      render();
      onChange(reminders);
    },
    getTasks: () => reminders,
  };
}
