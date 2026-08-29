import { beforeEach, describe, expect, it, vi } from "vitest";

const { showNotice } = vi.hoisted(() => ({
  showNotice: vi.fn(),
}));

vi.mock("obsidian", () => ({
  Notice: class Notice {
    constructor(message: string) {
      showNotice(message);
    }
  },
}));

import { persistReminderOrder } from "./persistReminderOrder";

beforeEach(() => {
  showNotice.mockReset();
});

describe("persistReminderOrder", () => {
  it("persists the committed order without restoring the view", async () => {
    const reorder = vi.fn(async () => {});
    const restoreOrder = vi.fn();

    await persistReminderOrder({ reorder }, "Work", ["r2", "r1"], restoreOrder);

    expect(reorder).toHaveBeenCalledWith("Work", ["r2", "r1"]);
    expect(restoreOrder).not.toHaveBeenCalled();
    expect(showNotice).not.toHaveBeenCalled();
  });

  it("restores the view and reports persistence failures", async () => {
    const reorder = vi.fn(async () => {
      throw new Error("vault write failed");
    });
    const restoreOrder = vi.fn();

    await persistReminderOrder({ reorder }, "Work", ["r2", "r1"], restoreOrder);

    expect(restoreOrder).toHaveBeenCalledTimes(1);
    expect(showNotice).toHaveBeenCalledWith(
      "Unable to reorder reminders: vault write failed",
    );
  });
});
