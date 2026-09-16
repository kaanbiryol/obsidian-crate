// Sample dates follow the visitor’s local calendar; source mode uses UTC.
const sampleDay = new Date();
const daysUntilFriday = (5 - sampleDay.getDay() + 7) % 7 || 7;
export const projects = [
  { id: 'inbox', name: 'Inbox' },
  { id: 'launch', name: 'Product launch' },
  { id: 'weekly', name: 'Weekly notes' },
  { id: 'reading', name: 'Reading list' },
];

export const initialReminders = [
  { id: 'capture', project: 'inbox', title: 'Book a table for Friday', description: 'Somewhere near the station.', date: '', day: null, time: 0 },
  { id: 'call', project: 'inbox', title: 'Call Alex', description: 'Catch up about the weekend.', date: 'Today, 17:00', day: 0, time: 17 },
  { id: 'organize', project: 'inbox', title: 'Gather the travel ideas', description: '', date: '', day: null, time: 0, completed: true },
  { id: 'launch', project: 'launch', title: 'Review launch notes', description: 'Check the copy before sharing.', date: 'Today, 18:00', day: 0, time: 18 },
  { id: 'screens', project: 'launch', title: 'Prepare the screenshots', description: 'Capture the desktop and mobile views.', date: 'Today, 20:00', day: 0, time: 20 },
  { id: 'weekly', project: 'weekly', title: 'Weekly review', description: 'Look back. Make a little room for next week.', date: 'Friday, 09:00', day: daysUntilFriday, time: 9 },
  { id: 'article', project: 'reading', title: 'Read the saved article', description: 'Keep one useful idea in this note.', date: 'Tomorrow, 10:00', day: 1, time: 10 },
].map((task) => {
  if (task.day === null) return task;
  const due = new Date(sampleDay);
  due.setDate(due.getDate() + task.day);
  due.setHours(task.time, 0, 0, 0);
  return { ...task, dueDatetime: due.toISOString() };
});

export function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === false || value == null) return;
    node.setAttribute(name, value === true ? '' : String(value));
  });
  node.append(...[children].flat(Infinity).filter((child) => child !== false && child != null));
  return node;
}

export function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  node.setAttribute('class', 'icon');
  node.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `../../assets/study-icons.svg#${name}`);
  node.append(use);
  return node;
}
