export type ReminderQueryOptions = {
  projectFilter?: string;
  showCompleted?: boolean;
  showToday?: boolean;
  showUpcoming?: boolean;
};

// Simple query parser - supports project filter and show-completed flag.
export function parseQuery(source: string): ReminderQueryOptions {
  const lines = source.trim().split("\n");
  const options: ReminderQueryOptions = {
    showCompleted: false,
    showToday: false,
    showUpcoming: false,
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const lower = line.toLowerCase();

    if (lower.startsWith("project:")) {
      const value = line.slice("project:".length).trim();
      if (value) {
        options.projectFilter = value;
      }
    } else if (lower.startsWith("show-completed:")) {
      const value = lower.slice("show-completed:".length).trim();
      if (value === "true") {
        options.showCompleted = true;
      } else if (value === "false") {
        options.showCompleted = false;
      }
    }
  }

  return options;
}
