import { Modal, Platform } from "obsidian";
import { type Root, createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { HeroUIProvider } from "@heroui/react";
import { createLogger } from "@/reminders";

import type CratePlugin from "@/main";

const log = createLogger('ReminderEditModal');
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { ModalContext, PluginContext } from "./reminders-context";
import { ReminderModal } from "./createReminderModal";
import { RemindersViewContent } from "./reminders-view";

/**
 * Base class for reminder modals with common setup logic
 */
abstract class BaseReminderModal extends Modal {
  protected readonly plugin: CratePlugin;
  private root: Root | undefined = undefined;

  constructor(plugin: CratePlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  /**
   * Subclasses must implement this to provide the modal content
   */
  protected abstract renderContent(): ReactElement;

  onOpen() {
    const { contentEl } = this;

    // Detect if on mobile
    const isMobile = Platform.isMobile;

    // Make Obsidian's modal container transparent and invisible
    this.modalEl.style.all = 'unset';
    this.modalEl.style.position = 'fixed';
    this.modalEl.style.inset = '0';
    this.modalEl.style.display = 'flex';
    // On mobile, align to bottom for bottom-sheet; on desktop, center
    this.modalEl.style.alignItems = isMobile ? 'flex-end' : 'center';
    this.modalEl.style.justifyContent = 'center';
    this.modalEl.style.pointerEvents = 'none';
    this.modalEl.style.zIndex = '9999';

    // Hide Obsidian's native close button (redundant with our custom UI)
    const closeButton = this.modalEl.querySelector('.modal-close-button') as HTMLElement;
    if (closeButton) {
      closeButton.style.display = 'none';
    }

    // Make content element a proper container for React portals
    contentEl.style.all = 'unset';
    contentEl.style.pointerEvents = 'auto';
    contentEl.style.display = 'block';
    contentEl.style.position = 'relative';
    contentEl.style.zIndex = '10000';

    // Detect if Obsidian is in dark mode
    const isDarkMode = document.body.classList.contains('theme-dark');

    const close = () => this.close();
    // Use document.body as popover container for proper positioning
    const popoverContainerEl = document.body;

    this.root = createRoot(contentEl);
    this.root.render(
      <PluginContext.Provider value={this.plugin}>
        <HeroUIProvider disableRipple>
          <div className={isDarkMode ? 'dark' : 'light'}>
            <ModalContext.Provider value={{ close, popoverContainerEl, isMobile }}>
              {this.renderContent()}
            </ModalContext.Provider>
          </div>
        </HeroUIProvider>
      </PluginContext.Provider>,
    );
  }

  onClose() {
    if (this.root) {
      this.root.unmount();
    }
  }
}

class ReminderCreationModal extends BaseReminderModal {
  private readonly initialProject: string | undefined;
  private readonly onCreate: ((reminder: any) => void) | undefined;

  constructor(
    plugin: CratePlugin,
    initialProject: string | undefined,
    onCreate?: (reminder: any) => void,
  ) {
    super(plugin);
    this.initialProject = initialProject;
    this.onCreate = onCreate;
  }

  protected renderContent(): ReactElement {
    return (
      <ReminderModal
        initialProject={this.initialProject}
        onSave={this.onCreate}
      />
    );
  }
}

class ReminderEditModal extends BaseReminderModal {
  private readonly reminder: Reminder;
  private readonly onUpdate: (action: 'saved' | 'deleted', reminder?: Reminder) => void;

  constructor(
    plugin: CratePlugin,
    reminder: Reminder,
    onUpdate: (action: 'saved' | 'deleted', reminder?: Reminder) => void,
  ) {
    super(plugin);
    this.reminder = reminder;
    this.onUpdate = onUpdate;
  }

  protected renderContent(): ReactElement {
    return (
      <ReminderModal
        reminder={this.reminder}
        onSave={(updatedReminder) => {
          log.info(' onSave called:', updatedReminder?.id);
          this.onUpdate('saved', updatedReminder);
        }}
        onDelete={() => {
          log.info(' onDelete called for reminder:', this.reminder.id);
          this.onUpdate('deleted');
        }}
      />
    );
  }
}

export function openReminderCreationModal(
  plugin: CratePlugin,
  initialProject?: string,
  onCreate?: (reminder: any) => void,
) {
  new ReminderCreationModal(plugin, initialProject, onCreate).open();
}

export function openReminderEditModal(
  plugin: CratePlugin,
  reminder: Reminder,
  onUpdate: (action: 'saved' | 'deleted', reminder?: Reminder) => void,
) {
  new ReminderEditModal(plugin, reminder, onUpdate).open();
}

/**
 * Full-screen modal that renders RemindersView as an overlay
 * Covers the entire viewport including Obsidian's bottom navigation bar
 */
class FullScreenReminderModal extends Modal {
  private readonly plugin: CratePlugin;
  private root: Root | undefined;
  private shadowRoot: ShadowRoot | null = null;

  constructor(plugin: CratePlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;

    // Full-screen takeover - cover everything including Obsidian's nav
    this.modalEl.style.all = 'unset';
    this.modalEl.style.position = 'fixed';
    this.modalEl.style.inset = '0';
    this.modalEl.style.zIndex = '9999';
    this.modalEl.style.display = 'flex';
    this.modalEl.style.flexDirection = 'column';
    this.modalEl.style.background = 'var(--background-primary)';

    // Hide Obsidian's close button
    const closeButton = this.modalEl.querySelector('.modal-close-button') as HTMLElement;
    if (closeButton) closeButton.style.display = 'none';

    // Content fills the modal
    contentEl.style.all = 'unset';
    contentEl.style.flex = '1';
    contentEl.style.display = 'flex';
    contentEl.style.flexDirection = 'column';
    contentEl.style.overflow = 'hidden';
    contentEl.style.height = '100%';

    // Create shadow root for CSS isolation
    this.shadowRoot = contentEl.attachShadow({ mode: 'open' });

    // Load styles into shadow DOM
    const styleSheet = document.createElement('style');
    styleSheet.textContent = await this.plugin.loadStyles();
    this.shadowRoot.appendChild(styleSheet);

    // Create mount point
    const mountPoint = document.createElement('div');
    mountPoint.className = 'reminders-shadow-root';
    this.shadowRoot.appendChild(mountPoint);

    // Render React
    const close = () => this.close();
    this.root = createRoot(mountPoint);
    this.root.render(
      <PluginContext.Provider value={this.plugin}>
        <RemindersViewContent
          plugin={this.plugin}
          shadowRoot={this.shadowRoot}
          isFullScreen={true}
          onClose={close}
          initialTab={this.plugin.remindersSettings.fullscreenDefaultTab}
        />
      </PluginContext.Provider>
    );
  }

  onClose() {
    if (this.root) this.root.unmount();
    this.shadowRoot = null;
  }
}

export function openFullScreenReminderModal(plugin: CratePlugin) {
  new FullScreenReminderModal(plugin).open();
}
