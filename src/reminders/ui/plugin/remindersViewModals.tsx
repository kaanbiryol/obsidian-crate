import { useRemindersSettingsStore } from "../../settings";
import { BaseUiModal } from "../../../ui/plugin/BaseUiModal";
import type CratePlugin from "@/plugin/CratePlugin";
import { PluginRoot } from "../../../ui/plugin/PluginRoot";
import { ProjectSheet } from "./ProjectSheet";
import { hideNativeModalCloseButton } from "../../../ui/plugin/shared-modal";
import { createShadowReactMount, type ShadowReactMount } from "../../../ui/plugin/shadowReactMount";

class CompactReminderModal extends BaseUiModal {
  private readonly plugin: CratePlugin;
  private unsubscribeSettings?: () => void;
  private readonly initialProject: string | undefined;
  private shadowMount: ShadowReactMount | null = null;
  private isOpen = false;

  constructor(plugin: CratePlugin, initialProject?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.initialProject = initialProject;
  }

  async onOpen(): Promise<void> {
    if (!this.plugin.remindersSettings.enabled) { this.close(); return; }
    this.unsubscribeSettings = useRemindersSettingsStore.subscribe(state => { if (!state.enabled) this.close(); });
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
      <PluginRoot plugin={this.plugin}>
        <ProjectSheet onClose={close} initialProject={this.initialProject} />
      </PluginRoot>,
    );
  }

  onClose(): void {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = undefined;
    this.isOpen = false;
    this.shadowMount?.unmount();
    this.shadowMount = null;
  }
}

export function openCompactReminderModal(plugin: CratePlugin, initialProject?: string): void {
  new CompactReminderModal(plugin, initialProject).open();
}
