import type { IndexedReminder } from "./index";

export interface ReminderLookupStore {
  rebuild(reminders: IndexedReminder[]): void;
  removeFile(filePath: string): IndexedReminder[];
  addReminders(reminders: IndexedReminder[]): void;
  renameFile(oldPath: string, newPath: string, newProject: string): void;
  getById(id: string): IndexedReminder | undefined;
  getByFile(filePath: string): IndexedReminder[];
  getProjects(discoveredProjects: Set<string>): string[];
}

export function createReminderLookupStore(): ReminderLookupStore {
  let byId = new Map<string, IndexedReminder>();
  let byFile = new Map<string, IndexedReminder[]>();
  let byProject = new Map<string, IndexedReminder[]>();

  function addReminder(reminder: IndexedReminder): void {
    byId.set(reminder.id, reminder);

    const fileReminders = byFile.get(reminder.filePath) || [];
    fileReminders.push(reminder);
    byFile.set(reminder.filePath, fileReminders);

    if (!reminder.project) {
      return;
    }

    const projectReminders = byProject.get(reminder.project) || [];
    projectReminders.push(reminder);
    byProject.set(reminder.project, projectReminders);
  }

  function removeReminderFromProject(reminder: IndexedReminder): void {
    if (!reminder.project) {
      return;
    }

    const projectReminders = byProject.get(reminder.project);
    if (!projectReminders) {
      return;
    }

    const filtered = projectReminders.filter((existing) => existing.id !== reminder.id);
    if (filtered.length > 0) {
      byProject.set(reminder.project, filtered);
    } else {
      byProject.delete(reminder.project);
    }
  }

  return {
    rebuild(reminders: IndexedReminder[]) {
      byId = new Map();
      byFile = new Map();
      byProject = new Map();

      for (const reminder of reminders) {
        addReminder(reminder);
      }
    },

    removeFile(filePath: string) {
      const removedReminders = byFile.get(filePath) || [];
      for (const reminder of removedReminders) {
        byId.delete(reminder.id);
        removeReminderFromProject(reminder);
      }

      byFile.delete(filePath);
      return removedReminders;
    },

    addReminders(reminders: IndexedReminder[]) {
      for (const reminder of reminders) {
        addReminder(reminder);
      }
    },

    renameFile(oldPath: string, newPath: string, newProject: string) {
      const fileReminders = byFile.get(oldPath) || [];
      byFile.delete(oldPath);

      for (const reminder of fileReminders) {
        reminder.filePath = newPath;

        if (reminder.project === newProject) {
          continue;
        }

        removeReminderFromProject(reminder);
        reminder.project = newProject;
        const newProjectReminders = byProject.get(newProject) || [];
        newProjectReminders.push(reminder);
        byProject.set(newProject, newProjectReminders);
      }

      if (fileReminders.length > 0) {
        byFile.set(newPath, fileReminders);
      }
    },

    getById(id: string) {
      return byId.get(id);
    },

    getByFile(filePath: string) {
      return byFile.get(filePath) || [];
    },

    getProjects(discoveredProjects: Set<string>) {
      return Array.from(new Set([...byProject.keys(), ...discoveredProjects])).sort();
    },
  };
}
