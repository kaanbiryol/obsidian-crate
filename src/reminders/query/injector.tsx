import type { MarkdownPostProcessorContext, MarkdownSectionInformation } from "obsidian";
import { MarkdownRenderChild, Platform } from "obsidian";
import type React from "react";
import { createRoot, type Root } from "react-dom/client";

import type CratePlugin from "@/main";
import { attachPluginStylesheet } from "@/reminders/ui/shadowStyles";
import { PluginContext } from "@/reminders/ui/reminders-context";
import { RemindersList } from "@/reminders/ui/remindersList/RemindersList";
import { hashFileContent } from "@/reminders/utils/hashing";
import { parseQuery } from "./queryOptions";

export { parseQuery, type ReminderQueryOptions } from "./queryOptions";

export class ReminderQueryInjector {
  private readonly plugin: CratePlugin;

  constructor(plugin: CratePlugin) {
    this.plugin = plugin;
  }

  onNewBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const parsed = parseQuery(source);

    const sectionInfo = ctx.getSectionInfo(el);
    const preferenceKey = buildQueryPreferenceKey(ctx.sourcePath, source, sectionInfo, "reminders");
    const savedPreference = preferenceKey
      ? this.plugin.remindersSettings.queryViewPreferences[preferenceKey]?.showCompleted
      : undefined;
    const effectiveShowCompleted = savedPreference ?? parsed.showCompleted;

    const toggleShowCompleted = preferenceKey
      ? this.createPreferenceSaver(preferenceKey)
      : undefined;

    const child = new ReactRenderer(
      el,
      this.plugin,
      RemindersList,
      {
        projectFilter: parsed.projectFilter,
        showCompleted: effectiveShowCompleted,
        showToday: parsed.showToday,
        onToggleShowCompleted: toggleShowCompleted,
      }
    );
    ctx.addChild(child);
  }

  onTodayBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const parsed = parseQuery(source);

    const sectionInfo = ctx.getSectionInfo(el);
    const preferenceKey = buildQueryPreferenceKey(ctx.sourcePath, source, sectionInfo, "reminders-today");
    const savedPreference = preferenceKey
      ? this.plugin.remindersSettings.queryViewPreferences[preferenceKey]?.showCompleted
      : undefined;
    const effectiveShowCompleted = savedPreference ?? parsed.showCompleted;

    const toggleShowCompleted = preferenceKey
      ? this.createPreferenceSaver(preferenceKey)
      : undefined;

    const child = new ReactRenderer(
      el,
      this.plugin,
      RemindersList,
      {
        projectFilter: parsed.projectFilter, // Show all projects unless filtered
        showCompleted: effectiveShowCompleted,
        showToday: true,
        onToggleShowCompleted: toggleShowCompleted,
      }
    );
    ctx.addChild(child);
  }

  onUpcomingBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const parsed = parseQuery(source);

    const sectionInfo = ctx.getSectionInfo(el);
    const preferenceKey = buildQueryPreferenceKey(ctx.sourcePath, source, sectionInfo, "reminders-upcoming");
    const savedPreference = preferenceKey
      ? this.plugin.remindersSettings.queryViewPreferences[preferenceKey]?.showCompleted
      : undefined;
    const effectiveShowCompleted = savedPreference ?? parsed.showCompleted;

    const toggleShowCompleted = preferenceKey
      ? this.createPreferenceSaver(preferenceKey)
      : undefined;

    const child = new ReactRenderer(
      el,
      this.plugin,
      RemindersList,
      {
        projectFilter: parsed.projectFilter,
        showCompleted: effectiveShowCompleted,
        showUpcoming: true,
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
      });
    };
  }
}

function buildQueryPreferenceKey(
  filePath: string,
  source: string,
  sectionInfo: MarkdownSectionInformation | null,
  blockType: "reminders" | "reminders-today" | "reminders-upcoming",
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
    // Create shadow root for CSS isolation
    this.shadowRoot = this.containerEl.attachShadow({ mode: "open" });
    const shadowRoot = this.shadowRoot;

    // Create mount point immediately so the shadow tree is stable, but wait for
    // the stylesheet before the first React paint to avoid a flash of unstyled content.
    const mountPoint = document.createElement("div");
    mountPoint.className = "reminders-shadow-root";
    shadowRoot.appendChild(mountPoint);

    // Sync dark mode
    if (document.body.classList.contains("theme-dark")) {
      mountPoint.classList.add("dark");
    }

    // Add mobile class for responsive styles
    if (Platform.isMobile) {
      mountPoint.classList.add("is-mobile");
    }

    void this.initializeReactRoot(shadowRoot, mountPoint);
  }

  onunload(): void {
    this.isDisposed = true;
    if (this.reactRoot) {
      this.reactRoot.unmount();
    }
    this.shadowRoot = null;
  }

  private async initializeReactRoot(shadowRoot: ShadowRoot, mountPoint: HTMLDivElement): Promise<void> {
    await attachPluginStylesheet(this.plugin, shadowRoot);

    if (this.isDisposed || this.shadowRoot !== shadowRoot) {
      return;
    }

    this.reactRoot = createRoot(mountPoint);
    const Component = this.component;
    this.reactRoot.render(
      <PluginContext.Provider value={this.plugin}>
        <Component {...this.props} />
      </PluginContext.Provider>,
    );
  }
}
