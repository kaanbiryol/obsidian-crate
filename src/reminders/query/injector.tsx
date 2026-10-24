import type { MarkdownPostProcessorContext } from "obsidian";
import { MarkdownRenderChild, Notice, Platform, TFile } from "obsidian";
import type React from "react";
import type { Root } from "react-dom/client";

import type CratePlugin from "@/main";
import { errorMessage } from "@/platform/logger";
import {
  createShadowReactRoot,
  createShadowRootMount,
  type ShadowRootMount,
} from "@/ui/plugin/shadowReactMount";
import { PluginContext } from "@/reminders/ui/plugin/reminders-context";
import { RemindersList } from "@/reminders/ui/plugin/reminder-list/RemindersList";
import { processVaultMarkdown } from "@/reminders/data/vault-markdown";
import { parseRemindersBlockOptions, setRemindersBlockShowCompleted, type RemindersBlockType } from "./remindersBlockOptions";

export class ReminderQueryInjector {
  private readonly plugin: CratePlugin;

  constructor(plugin: CratePlugin) {
    this.plugin = plugin;
  }

  onBlock(type: RemindersBlockType, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const options = parseRemindersBlockOptions({ type, content: source });

    // Like Live Preview, the toggle rewrites the block's own show-completed option.
    const toggleShowCompleted = ctx.sourcePath && ctx.getSectionInfo(el)
      ? (showCompleted: boolean) => {
        void writeShowCompleted(this.plugin, el, ctx, showCompleted).catch((error: unknown) => {
          new Notice(`Failed to save reminder view preference: ${errorMessage(error)}`);
        });
      }
      : undefined;

    const child = new ReactRenderer(
      el,
      this.plugin,
      RemindersList,
      {
        projectFilter: options.projectFilter,
        showCompleted: options.showCompleted,
        showToday: options.showToday,
        showUpcoming: options.showUpcoming,
        onToggleShowCompleted: toggleShowCompleted,
      }
    );
    ctx.addChild(child);
  }
}

async function writeShowCompleted(
  plugin: CratePlugin,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  showCompleted: boolean,
): Promise<void> {
  // Read the section when the toggle is used; edits above the block move it.
  const section = ctx.getSectionInfo(el);
  const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!section || !(file instanceof TFile)) throw new Error("This reminders block is no longer in the note.");
  const block = section.text.split("\n").slice(section.lineStart, section.lineEnd + 1).join("\n");
  const updated = setRemindersBlockShowCompleted(block, showCompleted);
  if (!updated) return;
  await processVaultMarkdown(plugin.app, file, content => {
    const lines = content.split("\n");
    if (lines.slice(section.lineStart, section.lineEnd + 1).join("\n") !== block) {
      throw new Error("This reminders block changed. Try again.");
    }
    return [...lines.slice(0, section.lineStart), updated, ...lines.slice(section.lineEnd + 1)].join("\n");
  });
}

class ReactRenderer<T extends object> extends MarkdownRenderChild {
  private readonly plugin: CratePlugin;
  private readonly props: T;
  private readonly component: React.FC<T>;
  private reactRoot: Root | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private isDisposed = false;

  constructor(
    container: HTMLElement,
    plugin: CratePlugin,
    component: React.FC<T>,
    props: T,
  ) {
    super(container);
    this.plugin = plugin;
    this.component = component;
    this.props = props;
  }

  onload(): void {
    const mount = createShadowRootMount(this.containerEl, {
      // The mount syncs the theme class itself.
      configureMountPoint: (mountPoint) => {
        // Add mobile class for responsive styles
        if (Platform.isMobile) {
          mountPoint.classList.add("is-mobile");
        }
      },
    });
    this.shadowRoot = mount.shadowRoot;

    void this.initializeReactRoot(mount);
  }

  onunload(): void {
    this.isDisposed = true;
    if (this.reactRoot) {
      this.reactRoot.unmount();
    }
    this.shadowRoot = null;
  }

  private async initializeReactRoot(mount: ShadowRootMount): Promise<void> {
    const root = await createShadowReactRoot(this.plugin, mount, {
      isActive: ({ shadowRoot }) => !this.isDisposed && this.shadowRoot === shadowRoot,
    });
    if (!root) {
      return;
    }

    this.reactRoot = root;
    const Component = this.component;
    this.reactRoot.render(
      <PluginContext.Provider value={this.plugin}>
        <Component {...this.props} />
      </PluginContext.Provider>,
    );
  }
}
