import type { App, TFile } from "obsidian";
import { createLogger } from "@/reminders/utils/logger";
import type { ReminderIndex } from "../reminder-index";
import { getInitialProjectFileContent } from "../../core/markdownReminderFile";
import {
  getReminderProjectFilePath,
  normalizeReminderProjectPath,
} from "../../core/reminderProjectPath";
export {
  findReminderLineNumber,
} from "../../core/markdownReminderFile";

const log = createLogger("MarkdownWriter");

function isTFileLike(value: unknown): value is TFile {
  return typeof value === "object"
    && value !== null
    && "path" in value
    && typeof value.path === "string"
    && "extension" in value
    && typeof value.extension === "string";
}

export async function getFile(app: App, filePath: string): Promise<TFile | null> {
  const abstractFile = app.vault.getAbstractFileByPath(filePath);
  if (isTFileLike(abstractFile)) {
    return abstractFile;
  }
  return null;
}

async function ensureFolderPath(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (!await app.vault.adapter.exists(currentPath)) {
      await app.vault.createFolder(currentPath);
      log.info(` Created folder: ${currentPath}`);
    }
  }
}

export async function getOrCreateProjectFile(
  app: App,
  index: ReminderIndex,
  project: string,
): Promise<TFile> {
  const folderPath = index.remindersFolderPath;
  const normalizedProject = normalizeReminderProjectPath(project);
  if (!normalizedProject) {
    throw new Error(`Invalid reminder project: ${project}`);
  }
  const filePath = getReminderProjectFilePath(folderPath, normalizedProject);
  const projectFolderPath = filePath.slice(0, filePath.lastIndexOf("/"));

  await ensureFolderPath(app, projectFolderPath);

  let file = await getFile(app, filePath);
  if (!file) {
    await app.vault.create(filePath, getInitialProjectFileContent(normalizedProject));
    file = await getFile(app, filePath);
    log.info(` Created project file: ${filePath}`);
  }

  if (!file) {
    throw new Error(`Failed to create project file: ${filePath}`);
  }

  return file;
}
