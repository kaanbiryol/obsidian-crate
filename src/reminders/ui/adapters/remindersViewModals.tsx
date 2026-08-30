import { Modal } from "obsidian";
import type CratePlugin from "@/main";
import { PluginContext } from "../reminders-context";
import { RemindersViewContent } from "./reminders-view";
import { hideNativeModalCloseButton } from "./modalShell";
import { createShadowReactMount, type ShadowReactMount } from "./shadowReactMount";

class FullScreenReminderModal extends Modal {
  private readonly plugin: CratePlugin;
  private readonly initialProject: string | undefined;
  private shadowMount: ShadowReactMount | null = null;
  private isOpen = false;

  constructor(plugin: CratePlugin, initialProject?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.initialProject = initialProject;
  }

  async onOpen(): Promise<void> {
    this.isOpen = true;
    const { contentEl } = this;

    this.modalEl.addClass("crate-reminders-fullscreen-modal");
    hideNativeModalCloseButton(this.modalEl);

    contentEl.addClass("crate-reminders-fullscreen-modal__content");

    const shadowMount = await createShadowReactMount(this.plugin, contentEl, {
      isActive: () => this.isOpen,
    });
    if (!shadowMount) {
      return;
    }
    this.shadowMount = shadowMount;

    const close = () => this.close();
    shadowMount.render(
      <PluginContext.Provider value={this.plugin}>
        <RemindersViewContent
          plugin={this.plugin}
          shadowRoot={shadowMount.shadowRoot}
          isFullScreen={true}
          onClose={close}
          initialTab={this.plugin.remindersSettings.fullscreenDefaultTab}
          initialProject={this.initialProject}
        />
      </PluginContext.Provider>,
    );
  }

  onClose(): void {
    this.isOpen = false;
    this.shadowMount?.unmount();
    this.shadowMount = null;
  }
}

class CompactReminderModal extends Modal {
  private readonly plugin: CratePlugin;
  private readonly initialProject: string | undefined;
  private shadowMount: ShadowReactMount | null = null;
  private isOpen = false;

  constructor(plugin: CratePlugin, initialProject?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.initialProject = initialProject;
  }

  async onOpen(): Promise<void> {
    this.isOpen = true;
    const { contentEl } = this;

    this.modalEl.addClass("crate-reminders-compact-modal");
    hideNativeModalCloseButton(this.modalEl);

    contentEl.addClass("crate-reminders-compact-modal__content");

    const shadowMount = await createShadowReactMount(this.plugin, contentEl, {
      isActive: () => this.isOpen,
    });
    if (!shadowMount) {
      return;
    }
    this.shadowMount = shadowMount;

    const close = () => this.close();
    shadowMount.render(
      <PluginContext.Provider value={this.plugin}>
        <RemindersViewContent
          plugin={this.plugin}
          shadowRoot={shadowMount.shadowRoot}
          isFullScreen={true}
          onClose={close}
          initialTab="browse"
          initialProject={this.initialProject}
          hideTabBar
        />
      </PluginContext.Provider>,
    );
  }

  onClose(): void {
    this.isOpen = false;
    this.shadowMount?.unmount();
    this.shadowMount = null;
  }
}

export function openFullScreenReminderModal(plugin: CratePlugin, initialProject?: string): void {
  new FullScreenReminderModal(plugin, initialProject).open();
}

export function openCompactReminderModal(plugin: CratePlugin, initialProject?: string): void {
  new CompactReminderModal(plugin, initialProject).open();
}
