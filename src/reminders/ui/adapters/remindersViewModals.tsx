import { Modal } from "obsidian";
import type CratePlugin from "@/main";
import { PluginContext } from "../reminders-context";
import { ProjectSheet } from "./ProjectSheet";
import { hideNativeModalCloseButton } from "./modalShell";
import { createShadowReactMount, type ShadowReactMount } from "./shadowReactMount";

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
        <ProjectSheet
          plugin={this.plugin}
          shadowRoot={shadowMount.shadowRoot}
          onClose={close}
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

export function openCompactReminderModal(plugin: CratePlugin, initialProject?: string): void {
  new CompactReminderModal(plugin, initialProject).open();
}
