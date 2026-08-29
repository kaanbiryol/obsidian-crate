import { describe, expect, it } from "vitest";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { buildDeleteConfirmationMessage } from "./deleteConfirmation";

function makeReminder(content: string): Reminder {
  return {
    id: "r1",
    content,
    priority: 4,
    completed: false,
  };
}

describe("buildDeleteConfirmationMessage", () => {
  it("keeps short reminder content intact", () => {
    expect(buildDeleteConfirmationMessage(makeReminder("Buy milk"))).toBe(
      'Are you sure you want to delete "Buy milk"? This action cannot be undone.',
    );
  });

  it("truncates long reminder content to preserve the existing preview behavior", () => {
    expect(
      buildDeleteConfirmationMessage(
        makeReminder("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"),
      ),
    ).toBe(
      'Are you sure you want to delete "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX..."? This action cannot be undone.',
    );
  });
});
