import type CratePlugin from "@/main";
import { attachPluginStylesheet } from "../shadowStyles";

export function hideNativeModalCloseButton(modalEl: HTMLElement): void {
  const closeButton = modalEl.querySelector(".modal-close-button");
  if (closeButton instanceof HTMLElement) {
    closeButton.setCssProps({ display: "none" });
  }
}

export async function createShadowRootMount(
  plugin: CratePlugin,
  contentEl: HTMLElement,
): Promise<{ shadowRoot: ShadowRoot; mountPoint: HTMLDivElement }> {
  const shadowRoot = contentEl.attachShadow({ mode: "open" });
  await attachPluginStylesheet(plugin, shadowRoot);

  const mountPoint = document.createElement("div");
  mountPoint.className = "reminders-shadow-root";
  shadowRoot.appendChild(mountPoint);

  return { shadowRoot, mountPoint };
}
