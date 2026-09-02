import { useEffect } from "react";

const STATUS_BAR_INSET_PROPERTY = "--reminders-host-bottom-inset";

type RectEdges = Pick<DOMRect, "top" | "right" | "bottom" | "left" | "height">;

export function calculateBottomOverlayInset(hostRect: RectEdges, overlayRect: RectEdges): number {
  const horizontalOverlap = Math.min(hostRect.right, overlayRect.right)
    - Math.max(hostRect.left, overlayRect.left);
  const verticalOverlap = Math.min(hostRect.bottom, overlayRect.bottom)
    - Math.max(hostRect.top, overlayRect.top);

  if (horizontalOverlap <= 0 || verticalOverlap <= 0) {
    return 0;
  }

  return Math.ceil(Math.min(hostRect.height, Math.max(0, hostRect.bottom - overlayRect.top)));
}

/**
 * Obsidian themes can either reserve room for the status bar or overlay it.
 * Measure overlap against the rendered Shadow DOM mount so reserved space is
 * not counted twice and overlaid bars still receive the correct clearance.
 */
export function useObsidianStatusBarInset(shadowRoot: ShadowRoot, enabled: boolean): void {
  useEffect(() => {
    const host = shadowRoot.host as HTMLElement;
    if (!enabled) {
      host.setCssProps({ [STATUS_BAR_INSET_PROPERTY]: "" });
      return;
    }

    const insetTarget = shadowRoot.querySelector<HTMLElement>(".reminders-shadow-root") ?? host;
    const statusBar = document.querySelector<HTMLElement>(".status-bar");
    const updateInset = () => {
      if (!statusBar) {
        host.setCssProps({ [STATUS_BAR_INSET_PROPERTY]: "0px" });
        return;
      }

      const style = getComputedStyle(statusBar);
      const isVisible = style.display !== "none"
        && style.visibility !== "hidden"
        && Number.parseFloat(style.opacity || "1") > 0;
      const inset = isVisible
        ? calculateBottomOverlayInset(insetTarget.getBoundingClientRect(), statusBar.getBoundingClientRect())
        : 0;
      host.setCssProps({ [STATUS_BAR_INSET_PROPERTY]: `${inset}px` });
    };

    updateInset();

    const resizeObserver = new ResizeObserver(updateInset);
    resizeObserver.observe(insetTarget);
    if (statusBar) {
      resizeObserver.observe(statusBar);
    }

    const mutationObserver = new MutationObserver(updateInset);
    mutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    if (statusBar) {
      mutationObserver.observe(statusBar, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    }

    window.addEventListener("resize", updateInset);
    return () => {
      window.removeEventListener("resize", updateInset);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      host.setCssProps({ [STATUS_BAR_INSET_PROPERTY]: "" });
    };
  }, [enabled, shadowRoot]);
}
