import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type CratePlugin from "@/main";
import { attachPluginStylesheet } from "../shadowStyles";

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

export function createShadowRootMount(
  host: HTMLElement,
  options: ShadowRootMountOptions = {},
): ShadowRootMount {
  const shadowRoot = host.attachShadow({ mode: "open" });
  const mountPoint = document.createElement("div");
  mountPoint.className = options.mountClassName ?? "reminders-shadow-root";
  options.configureMountPoint?.(mountPoint);
  shadowRoot.appendChild(mountPoint);
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
