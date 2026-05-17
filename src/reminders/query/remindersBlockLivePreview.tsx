import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { createRoot, Root } from "react-dom/client";

import type CratePlugin from "@/main";
import { attachPluginStylesheet } from "@/reminders/ui/shadowStyles";
import { PluginContext } from "@/reminders/ui/reminders-context";
import { RemindersList } from "@/reminders/ui/reminder-list/RemindersList";
import { getEditorFile } from "./editorFile";
import type { ReminderQueryOptions } from "./queryOptions";
import {
  extractRemindersBlockInfo,
  isRemindersBlockStart,
  parseRemindersBlockOptions,
  setRemindersBlockShowCompleted,
} from "./remindersBlockOptions";

type WidgetHost = HTMLDivElement & {
  crateReactRoot?: Root;
  crateShadowRoot?: ShadowRoot;
  crateMountPoint?: HTMLDivElement;
  crateDisposed?: boolean;
};

class RemindersBlockWidget extends WidgetType {
  private readonly plugin: CratePlugin;
  private options: ReminderQueryOptions; // Made mutable for updateDOM
  private readonly currentFilePath: string | undefined;
  private readonly view: EditorView;
  private readonly from: number;
  private to: number;

  constructor(
    plugin: CratePlugin,
    options: ReminderQueryOptions,
    currentFilePath: string | undefined,
    view: EditorView,
    from: number,
    to: number
  ) {
    super();
    this.plugin = plugin;
    this.options = options;
    this.currentFilePath = currentFilePath;
    this.view = view;
    this.from = from;
    this.to = to;
  }

  eq(other: RemindersBlockWidget): boolean {
    // Consider widgets equal if only showCompleted changed
    // This prevents unnecessary widget recreation when toggling
    const optionsWithoutShowCompleted = { ...this.options, showCompleted: undefined };
    const otherOptionsWithoutShowCompleted = { ...other.options, showCompleted: undefined };

    const isSameBlock =
      this.currentFilePath === other.currentFilePath &&
      JSON.stringify(optionsWithoutShowCompleted) === JSON.stringify(otherOptionsWithoutShowCompleted) &&
      this.from === other.from;

    if (isSameBlock) {
      // Keep track of the latest range so updateDOM reads the full block.
      this.to = other.to;
    }

    return isSameBlock;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    // Re-parse the current block to get updated options
    const blockText = view.state.doc.sliceString(this.from, this.to);
    const blockInfo = extractRemindersBlockInfo(blockText);

    if (!blockInfo) {
      return false; // Can't update, need to recreate
    }

    const newOptions = parseRemindersBlockOptions(blockInfo);

    // Update options
    this.options = newOptions;

    // Re-render React component with new props
    const host = dom as WidgetHost;
    const root = host.crateReactRoot;
    const shadowRoot = host.crateShadowRoot;
    const mountPoint = host.crateMountPoint;
    if (root && shadowRoot) {
      // Update dark mode class
      if (mountPoint) {
        if (document.body.classList.contains("theme-dark")) {
          mountPoint.classList.add("dark");
        } else {
          mountPoint.classList.remove("dark");
        }
      }

      root.render(
        <PluginContext.Provider value={this.plugin}>
          <RemindersList
            projectFilter={newOptions.projectFilter}
            showCompleted={newOptions.showCompleted}
            showToday={newOptions.showToday}
            showUpcoming={newOptions.showUpcoming}
            onToggleShowCompleted={this.toggleShowCompleted}
          />
        </PluginContext.Provider>,
      );
      return true; // Successfully updated in place
    }

    return !!shadowRoot; // Initial render may still be waiting on stylesheet attachment
  }

  private toggleShowCompleted = (newValue: boolean) => {
    // Small delay to ensure React state update completes before document edit
    // Widget will update in place via updateDOM() - no recreation, no flicker
    setTimeout(() => {
      const blockText = this.view.state.doc.sliceString(this.from, this.to);
      const newContent = setRemindersBlockShowCompleted(blockText, newValue);
      if (!newContent) {
        return;
      }

      // Apply the edit
      this.view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: newContent,
        }
      });
    }, 50); // Minimal delay for smooth state transition
  };

  toDOM(): HTMLElement {
    const container = document.createElement("div") as WidgetHost;
    container.className = "reminders-block-widget";

    // Create shadow root for CSS isolation
    const shadowRoot = container.attachShadow({ mode: "open" });

    // Create mount point inside shadow DOM
    const mountPoint = document.createElement("div");
    mountPoint.className = "reminders-shadow-root";
    shadowRoot.appendChild(mountPoint);

    // Sync dark mode
    if (document.body.classList.contains("theme-dark")) {
      mountPoint.classList.add("dark");
    }

    container.crateShadowRoot = shadowRoot;
    container.crateMountPoint = mountPoint;

    void this.initializeRoot(container, shadowRoot, mountPoint);

    return container;
  }

  destroy(dom: HTMLElement): void {
    const host = dom as WidgetHost;
    host.crateDisposed = true;
    const root = host.crateReactRoot;
    if (root) {
      root.unmount();
    }
  }

  private async initializeRoot(
    host: WidgetHost,
    shadowRoot: ShadowRoot,
    mountPoint: HTMLDivElement,
  ): Promise<void> {
    await attachPluginStylesheet(this.plugin, shadowRoot);

    if (host.crateDisposed || host.crateShadowRoot !== shadowRoot) {
      return;
    }

    const root = createRoot(mountPoint);
    host.crateReactRoot = root;
    root.render(
      <PluginContext.Provider value={this.plugin}>
        <RemindersList
          projectFilter={this.options.projectFilter}
          showCompleted={this.options.showCompleted}
          showToday={this.options.showToday}
          showUpcoming={this.options.showUpcoming}
          onToggleShowCompleted={this.toggleShowCompleted}
        />
      </PluginContext.Provider>,
    );
  }
}

export function createRemindersBlockExtension(plugin: CratePlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        // Always rebuild on doc changes (content changed)
        if (update.docChanged) {
          this.decorations = this.buildDecorations(update.view);
          return;
        }

        // For selection changes, only rebuild if selection entered/left a reminders block
        // This prevents unnecessary widget recreation on every cursor move
        if (update.selectionSet) {
          const oldCursor = update.startState.selection.main.head;
          const newCursor = update.state.selection.main.head;

          // Only rebuild if cursor crossed a block boundary
          const wasInBlock = this.cursorInRemindersBlock(update.startState, oldCursor);
          const isInBlock = this.cursorInRemindersBlock(update.state, newCursor);

          if (wasInBlock !== isInBlock) {
            this.decorations = this.buildDecorations(update.view);
          }
          return;
        }

        // Viewport changes - rebuild (necessary for scrolling into new blocks)
        if (update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      private cursorInRemindersBlock(state: EditorState, pos: number): boolean {
        let inBlock = false;
        syntaxTree(state).iterate({
          from: pos,
          to: pos,
          enter: (node) => {
            if (
              node.name === "HyperMD-codeblock" ||
              node.name === "FencedCode" ||
              node.name.includes("codeblock")
            ) {
              const text = state.doc.sliceString(node.from, Math.min(node.from + 50, node.to));
              if (isRemindersBlockStart(text)) {
                inBlock = true;
              }
            }
          }
        });
        return inBlock;
      }

      buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const cursorPos = view.state.selection.main.head;
        const file = getEditorFile(view.state);
        const filePath = file?.path;

        for (const { from, to } of view.visibleRanges) {
          syntaxTree(view.state).iterate({
            from,
            to,
            enter: (node) => {
              if (
                node.name === "HyperMD-codeblock" ||
                node.name === "FencedCode" ||
                node.name.includes("codeblock")
              ) {
                // Skip if cursor is inside block to allow editing
                if (cursorPos > node.from && cursorPos < node.to) {
                  return;
                }

                const blockText = view.state.doc.sliceString(node.from, node.to);
                const blockInfo = extractRemindersBlockInfo(blockText);
                if (!blockInfo) {
                  return;
                }

                const options = parseRemindersBlockOptions(blockInfo);

                const widget = new RemindersBlockWidget(
                  plugin,
                  options,
                  filePath,
                  view,
                  node.from,
                  node.to
                );
                const deco = Decoration.replace({
                  widget,
                  block: true,
                });

                builder.add(node.from, node.to, deco);
              }
            },
          });
        }

        return builder.finish();
      }
    },
    {
      decorations: v => v.decorations,
    },
  );
}
