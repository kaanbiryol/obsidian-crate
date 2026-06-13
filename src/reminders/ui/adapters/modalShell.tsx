export function hideNativeModalCloseButton(modalEl: HTMLElement): void {
  const closeButton = modalEl.querySelector(".modal-close-button");
  if (closeButton instanceof HTMLElement) {
    closeButton.setCssProps({ display: "none" });
  }
}
