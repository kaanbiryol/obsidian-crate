import { editorViewField } from "obsidian";
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
import { PluginContext } from "@/reminders/ui/reminders-context";
import { RemindersList } from "@/reminders/ui/remindersList/RemindersList";
import { parseQuery, type ReminderQueryOptions } from "./injector";

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
    const blockInfo = extractBlockInfo(view, this.from, this.to);

    if (!blockInfo) {
      return false; // Can't update, need to recreate
    }

    const newOptions = parseBlockOptions(blockInfo.content, blockInfo.isToday, blockInfo.isUpcoming);

    // Update options
    this.options = newOptions;

    // Re-render React component with new props
    const root = (dom as any)._reactRoot as Root | undefined;
    const shadowRoot = (dom as any)._shadowRoot as ShadowRoot | undefined;
    if (root && shadowRoot) {
      // Update dark mode class
      const mountPoint = shadowRoot.querySelector(".reminders-shadow-root") as HTMLElement;
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

    return false; // Need to recreate
  }

  private toggleShowCompleted = (newValue: boolean) => {
    // Small delay to ensure React state update completes before document edit
    // Widget will update in place via updateDOM() - no recreation, no flicker
    setTimeout(() => {
      const blockText = this.view.state.doc.sliceString(this.from, this.to);
      const lines = blockText.split("\n");

      // Find the opening ``` line
      const openingIndex = lines.findIndex(line => line.trim().startsWith("```"));
      if (openingIndex === -1) return;

      // Find the closing ``` line
      const closingIndex = lines.findIndex((line, idx) => idx > openingIndex && line.trim().startsWith("```"));
      if (closingIndex === -1) return;

      // Get content lines (between opening and closing)
      const contentLines = lines.slice(openingIndex + 1, closingIndex);

      const existingLine = contentLines.find(line => line.trim().startsWith("show-completed:"));
      const indentation = existingLine?.match(/^\s*/)?.[0] ?? "";

      // Remove existing show-completed line
      const filteredLines = contentLines.filter(line => !line.trim().startsWith("show-completed:"));

      // Add new show-completed line with explicit value
      filteredLines.push(`${indentation}show-completed: ${newValue}`);

      // Reconstruct the block
      const newContent = [
        lines[openingIndex],
        ...filteredLines,
        ...lines.slice(closingIndex)
      ].join("\n");

      // Apply the edit
      this.view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: newContent
        }
      });
    }, 50); // Minimal delay for smooth state transition
  };

  toDOM(): HTMLElement {
    const container = document.createElement("div");
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

    const root: Root = createRoot(mountPoint);
    (container as any)._reactRoot = root;
    (container as any)._shadowRoot = shadowRoot;

    // Load styles async and render
    this.plugin.loadStyles().then((styles: string) => {
      const styleSheet = document.createElement("style");
      styleSheet.textContent = styles;
      shadowRoot.insertBefore(styleSheet, shadowRoot.firstChild);
    });

    // Render immediately (styles will apply when loaded)
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

    return container;
  }

  destroy(dom: HTMLElement): void {
    const root = (dom as any)._reactRoot as Root | undefined;
    if (root) {
      root.unmount();
    }
  }
}

function extractBlockInfo(view: EditorView, from: number, to: number): { content: string; isToday: boolean; isUpcoming: boolean } | null {
  const blockText = view.state.doc.sliceString(from, to);
  const lines = blockText.split("\n");
  if (lines.length < 2) {
    return null;
  }

  const opening = lines[0].trim();
  if (!opening.startsWith("```")) {
    return null;
  }

  const blockWidgetType = opening.slice(3).trim().toLowerCase();

  // Only support reminders, reminders-today, and reminders-upcoming
  if (blockWidgetType !== "reminders" && blockWidgetType !== "reminders-today" && blockWidgetType !== "reminders-upcoming") {
    return null;
  }

  const isToday = blockWidgetType === "reminders-today";
  const isUpcoming = blockWidgetType === "reminders-upcoming";

  const closingIndex = lines.findIndex((line, idx) => idx !== 0 && line.trim().startsWith("```"));
  const contentLines = closingIndex === -1 ? lines.slice(1) : lines.slice(1, closingIndex);
  const content = contentLines.join("\n");

  return { content, isToday, isUpcoming };
}

function parseBlockOptions(content: string, isToday: boolean, isUpcoming: boolean): ReminderQueryOptions {
  const parsed = parseQuery(content);

  if (isToday) {
    return {
      ...parsed,
      showToday: true,
      projectFilter: undefined, // Show all projects for reminders-today
    };
  }

  if (isUpcoming) {
    return {
      ...parsed,
      showUpcoming: true,
    };
  }

  return parsed;
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
              if (text.match(/^```reminders(-today|-upcoming)?/)) {
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
        const file = view.state.field(editorViewField)?.file;
        const filePath = file?.path;

        for (const { from, to } of view.visibleRanges) {
          syntaxTree(view.state).iterate({
            from,
            to,
            enter: (node: any) => {
              if (
                node.name === "HyperMD-codeblock" ||
                node.name === "FencedCode" ||
                node.name.includes("codeblock")
              ) {
                // Skip if cursor is inside block to allow editing
                if (cursorPos > node.from && cursorPos < node.to) {
                  return;
                }

                const blockInfo = extractBlockInfo(view, node.from, node.to);
                if (!blockInfo) {
                  return;
                }

                const options = parseBlockOptions(blockInfo.content, blockInfo.isToday, blockInfo.isUpcoming);

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
