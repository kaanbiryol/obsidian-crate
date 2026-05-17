import { Modal } from "obsidian";
import { type Root, createRoot } from "react-dom/client";
import type CratePlugin from "@/main";
import { PluginContext } from "../reminders-context";
import { RemindersViewContent } from "./reminders-view";
import { createShadowRootMount, hideNativeModalCloseButton } from "./modalShell";

class FullScreenReminderModal extends Modal {
  private readonly plugin: CratePlugin;
  private readonly initialProject: string | undefined;
  private root: Root | undefined;
  private shadowRoot: ShadowRoot | null = null;

  constructor(plugin: CratePlugin, initialProject?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.initialProject = initialProject;
  }

  async onOpen(): Promise<void> {
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

    const { shadowRoot, mountPoint } = await createShadowRootMount(this.plugin, contentEl);
    this.shadowRoot = shadowRoot;

    const close = () => this.close();
    this.root = createRoot(mountPoint);
    this.root.render(
      <PluginContext.Provider value={this.plugin}>
        <RemindersViewContent
          plugin={this.plugin}
          shadowRoot={shadowRoot}
          isFullScreen={true}
          onClose={close}
          initialTab={this.plugin.remindersSettings.fullscreenDefaultTab}
          initialProject={this.initialProject}
        />
      </PluginContext.Provider>,
    );
  }

  onClose(): void {
    this.root?.unmount();
    this.shadowRoot = null;
  }
}

class CompactReminderModal extends Modal {
  private readonly plugin: CratePlugin;
  private readonly initialProject: string | undefined;
  private root: Root | undefined;
  private shadowRoot: ShadowRoot | null = null;

  constructor(plugin: CratePlugin, initialProject?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.initialProject = initialProject;
  }

  async onOpen(): Promise<void> {
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

    const { shadowRoot, mountPoint } = await createShadowRootMount(this.plugin, contentEl);
    this.shadowRoot = shadowRoot;

    const close = () => this.close();
    this.root = createRoot(mountPoint);
    this.root.render(
      <PluginContext.Provider value={this.plugin}>
        <RemindersViewContent
          plugin={this.plugin}
          shadowRoot={shadowRoot}
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
    this.root?.unmount();
    this.shadowRoot = null;
  }
}

export function openFullScreenReminderModal(plugin: CratePlugin, initialProject?: string): void {
  new FullScreenReminderModal(plugin, initialProject).open();
}

export function openCompactReminderModal(plugin: CratePlugin, initialProject?: string): void {
  new CompactReminderModal(plugin, initialProject).open();
}
