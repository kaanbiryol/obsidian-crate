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

    this.modalEl.setCssProps({
      all: "unset",
      position: "fixed",
      inset: "0",
      "z-index": "9999",
      display: "flex",
      "flex-direction": "column",
      background: "var(--background-primary)",
    });
    hideNativeModalCloseButton(this.modalEl);

    contentEl.setCssProps({
      all: "unset",
      flex: "1",
      display: "flex",
      "flex-direction": "column",
      overflow: "hidden",
      height: "100%",
    });

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

    this.modalEl.setCssProps({
      all: "unset",
      position: "fixed",
      inset: "0",
      "z-index": "9999",
      display: "flex",
      "align-items": "center",
      "justify-content": "center",
      background: "rgba(0, 0, 0, 0.5)",
    });
    hideNativeModalCloseButton(this.modalEl);

    contentEl.setCssProps({
      all: "unset",
      display: "flex",
      "flex-direction": "column",
      overflow: "hidden",
      width: "90vw",
      height: "85vh",
      "max-width": "500px",
      "max-height": "700px",
      "border-radius": "12px",
      background: "var(--background-primary)",
      "box-shadow": "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
    });

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
