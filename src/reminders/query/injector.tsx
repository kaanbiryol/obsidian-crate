import type { MarkdownPostProcessorContext, MarkdownSectionInformation } from "obsidian";
import { MarkdownRenderChild, Notice, Platform } from "obsidian";
import type React from "react";
import type { Root } from "react-dom/client";

import type CratePlugin from "@/main";
import { errorMessage } from "@/sync/logger";
import {
  createShadowReactRoot,
  createShadowRootMount,
  type ShadowRootMount,
} from "@/ui/plugin/shadowReactMount";
import { PluginContext } from "@/reminders/ui/plugin/reminders-context";
import { RemindersList } from "@/reminders/ui/reminder-list/RemindersList";
import { hashFileContent } from "@/reminders/query/hashing";
import { parseRemindersBlockOptions, type RemindersBlockType } from "./remindersBlockOptions";

export class ReminderQueryInjector {
  private readonly plugin: CratePlugin;

  constructor(plugin: CratePlugin) {
    this.plugin = plugin;
  }

  onBlock(type: RemindersBlockType, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const options = parseRemindersBlockOptions({ type, content: source });

    const sectionInfo = ctx.getSectionInfo(el);
    const preferenceKey = buildQueryPreferenceKey(ctx.sourcePath, source, sectionInfo, type);
    const savedPreference = preferenceKey
      ? this.plugin.remindersSettings.queryViewPreferences[preferenceKey]?.showCompleted
      : undefined;
    const effectiveShowCompleted = savedPreference ?? options.showCompleted;

    const toggleShowCompleted = preferenceKey
      ? this.createPreferenceSaver(preferenceKey)
      : undefined;

    const child = new ReactRenderer(
      el,
      this.plugin,
      RemindersList,
      {
        projectFilter: options.projectFilter,
        showCompleted: effectiveShowCompleted,
        showToday: options.showToday,
        showUpcoming: options.showUpcoming,
        onToggleShowCompleted: toggleShowCompleted,
      }
    );
    ctx.addChild(child);
  }

  private createPreferenceSaver(key: string) {
    return (newValue: boolean) => {
      const current = this.plugin.remindersSettings.queryViewPreferences ?? {};
      const nextPreferences = {
        ...current,
        [key]: {
          ...current[key],
          showCompleted: newValue,
        },
      };

      void this.plugin.writeRemindersSettings({
        queryViewPreferences: nextPreferences,
      }).catch((error: unknown) => {
        new Notice(`Failed to save reminder view preference: ${errorMessage(error)}`);
      });
    };
  }
}

function buildQueryPreferenceKey(
  filePath: string,
  source: string,
  sectionInfo: MarkdownSectionInformation | null,
  blockType: RemindersBlockType,
): string | undefined {
  if (!filePath || !sectionInfo) {
    return undefined;
  }

  const normalizedSource = source.trim();
  const keySeed = `${filePath}::${blockType}::${sectionInfo.lineStart ?? "?"}::${sectionInfo.lineEnd ?? "?"}::${normalizedSource}`;
  return hashFileContent(keySeed);
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
      configureMountPoint: (mountPoint) => {
        // Sync dark mode
        if (document.body.classList.contains("theme-dark")) {
          mountPoint.classList.add("dark");
        }

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
