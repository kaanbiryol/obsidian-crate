import { TFile, type App } from "obsidian";
import { createLogger } from "@/reminders/utils/logger";
import { createReminderId, setReminderIdMarker } from "../core/reminderIdentity";
import { isInRemindersFolder } from "./vaultScanner";
import { parseCheckboxLine } from "@/reminders/utils/checkboxParser";

const log = createLogger("ReminderIdMigration");

interface ReminderIdMigrationResult {
  filesUpdated: number;
  remindersUpdated: number;
}

function listReminderMarkdownFiles(app: App, remindersFolderPath: string): TFile[] {
  return app.vault.getMarkdownFiles().filter((file) =>
    isInRemindersFolder(file.path, remindersFolderPath)
  );
}

export async function migrateReminderIds(
  app: App,
  remindersFolderPath: string,
): Promise<ReminderIdMigrationResult> {
  const files = listReminderMarkdownFiles(app, remindersFolderPath);
  let filesUpdated = 0;
  let remindersUpdated = 0;

  for (const file of files) {
    try {
      const content = await app.vault.cachedRead(file);
      const lines = content.split("\n");
      let fileChanged = false;

      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const parsed = parseCheckboxLine(line);
        if (!parsed || !parsed.parsed.cleanContent.trim() || parsed.reminderId) {
          continue;
        }

        lines[index] = setReminderIdMarker(
          line,
          createReminderId(),
        );
        fileChanged = true;
        remindersUpdated++;
      }

      if (!fileChanged) {
        continue;
      }

      await app.vault.modify(file, lines.join("\n"));
      filesUpdated++;
    } catch (error) {
      log.error(` Failed to migrate reminder IDs for ${file.path}:`, error);
    }
  }

  if (remindersUpdated > 0) {
    log.info(` Added ${remindersUpdated} reminder identifiers across ${filesUpdated} files`);
  }

  return { filesUpdated, remindersUpdated };
}
