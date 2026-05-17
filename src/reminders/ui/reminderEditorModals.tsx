import { HeroUIProvider } from "@heroui/react";
import { Modal, Platform } from "obsidian";
import type { ReactElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import type CratePlugin from "@/main";
import { createLogger } from "@/reminders/utils/logger";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { ReminderModal } from "./createReminderModal";
import { ModalContext, PluginContext } from "./reminders-context";
import { hideNativeModalCloseButton } from "./modalShell";

const log = createLogger("ReminderEditModal");

abstract class BaseReminderModal extends Modal {
  protected readonly plugin: CratePlugin;
  private root: Root | undefined;

  constructor(plugin: CratePlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  protected abstract renderContent(): ReactElement;

  onOpen(): void {
    const { contentEl } = this;
    const isMobile = Platform.isMobile;

    this.modalEl.setCssProps({
      all: "unset",
      position: "fixed",
      inset: "0",
      display: "flex",
      "align-items": isMobile ? "flex-end" : "center",
      "justify-content": "center",
      "pointer-events": "none",
      "z-index": "9999",
    });
    hideNativeModalCloseButton(this.modalEl);

    contentEl.setCssProps({
      all: "unset",
      "pointer-events": "auto",
      display: "block",
      position: "relative",
      "z-index": "10000",
    });

    const isDarkMode = document.body.classList.contains("theme-dark");
    const close = () => this.close();
    const popoverContainerEl = document.body;

    this.root = createRoot(contentEl);
    this.root.render(
      <PluginContext.Provider value={this.plugin}>
        <HeroUIProvider disableRipple>
          <div className={isDarkMode ? "dark" : "light"}>
            <ModalContext.Provider value={{ close, popoverContainerEl, isMobile }}>
              {this.renderContent()}
            </ModalContext.Provider>
          </div>
        </HeroUIProvider>
      </PluginContext.Provider>,
    );
  }

  onClose(): void {
    this.root?.unmount();
  }
}

class ReminderCreationModal extends BaseReminderModal {
  private readonly initialProject: string | undefined;
  private readonly onCreate: ((reminder: Reminder | null) => void) | undefined;

  constructor(
    plugin: CratePlugin,
    initialProject: string | undefined,
    onCreate?: (reminder: Reminder | null) => void,
  ) {
    super(plugin);
    this.initialProject = initialProject;
    this.onCreate = onCreate;
  }

  protected renderContent(): ReactElement {
    return <ReminderModal initialProject={this.initialProject} onSave={this.onCreate} />;
  }
}

class ReminderEditModal extends BaseReminderModal {
  private readonly reminder: Reminder;
  private readonly onUpdate: (action: "saved" | "deleted", reminder?: Reminder) => void;

  constructor(
    plugin: CratePlugin,
    reminder: Reminder,
    onUpdate: (action: "saved" | "deleted", reminder?: Reminder) => void,
  ) {
    super(plugin);
    this.reminder = reminder;
    this.onUpdate = onUpdate;
  }

  protected renderContent(): ReactElement {
    return (
      <ReminderModal
        reminder={this.reminder}
        onSave={(updatedReminder: Reminder | null) => {
          log.info(" onSave called:", updatedReminder?.id);
          this.onUpdate("saved", updatedReminder ?? undefined);
        }}
        onDelete={() => {
          log.info(" onDelete called for reminder:", this.reminder.id);
          this.onUpdate("deleted");
        }}
      />
    );
  }
}

export function openReminderCreationModal(
  plugin: CratePlugin,
  initialProject?: string,
  onCreate?: (reminder: Reminder | null) => void,
): void {
  new ReminderCreationModal(plugin, initialProject, onCreate).open();
}

export function openReminderEditModal(
  plugin: CratePlugin,
  reminder: Reminder,
  onUpdate: (action: "saved" | "deleted", reminder?: Reminder) => void,
): void {
  new ReminderEditModal(plugin, reminder, onUpdate).open();
}
