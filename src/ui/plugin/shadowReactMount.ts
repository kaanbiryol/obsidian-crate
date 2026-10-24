import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type CratePlugin from "@/main";
import { attachPluginStylesheet } from "./shadowStyles";

export interface ShadowRootMount {
  shadowRoot: ShadowRoot;
  mountPoint: HTMLDivElement;
}

export interface ShadowReactMount extends ShadowRootMount {
  root: Root;
  render(children: ReactNode): void;
  unmount(): void;
}

interface ShadowRootMountOptions {
  mountClassName?: string;
  configureMountPoint?(mountPoint: HTMLDivElement): void;
}

interface ShadowReactRootOptions {
  isActive?(mount: ShadowRootMount): boolean;
}

interface ShadowReactMountOptions extends ShadowRootMountOptions, ShadowReactRootOptions {}

/** Mirrors Obsidian's body theme class onto a shadow mount point. */
export function syncMountTheme(mountPoint: HTMLElement): void {
  const dark = mountPoint.doc.body.classList.contains("theme-dark");
  mountPoint.classList.toggle("dark", dark);
  mountPoint.classList.toggle("light", !dark);
}

export function createShadowRootMount(
  host: HTMLElement,
  options: ShadowRootMountOptions = {},
): ShadowRootMount {
  const shadowRoot = host.attachShadow({ mode: "open" });
  const mountPoint = shadowRoot.createDiv();
  mountPoint.className = options.mountClassName ?? "reminders-shadow-root";
  mountPoint.classList.add("crate-reminders-ui");
  mountPoint.dataset.uiHost = "plugin";
  mountPoint.classList.toggle("is-mobile", host.doc.body.classList.contains("is-mobile"));
  syncMountTheme(mountPoint);
  // Obsidian switches theme on the body, e.g. when a phone follows the system appearance.
  const themeObserver = new MutationObserver(() => {
    if (!host.isConnected) themeObserver.disconnect();
    else syncMountTheme(mountPoint);
  });
  themeObserver.observe(host.doc.body, { attributes: true, attributeFilter: ["class"] });
  options.configureMountPoint?.(mountPoint);
  return { shadowRoot, mountPoint };
}

export async function createShadowReactRoot(
  plugin: CratePlugin,
  mount: ShadowRootMount,
  options: ShadowReactRootOptions = {},
): Promise<Root | null> {
  await attachPluginStylesheet(plugin, mount.shadowRoot);

  if (options.isActive && !options.isActive(mount)) {
    return null;
  }

  return createRoot(mount.mountPoint);
}

export async function createShadowReactMount(
  plugin: CratePlugin,
  host: HTMLElement,
  options: ShadowReactMountOptions = {},
): Promise<ShadowReactMount | null> {
  const mount = createShadowRootMount(host, options);
  const root = await createShadowReactRoot(plugin, mount, options);
  if (!root) {
    return null;
  }

  return {
    ...mount,
    root,
    render: (children: ReactNode) => root.render(children),
    unmount: () => root.unmount(),
  };
}
