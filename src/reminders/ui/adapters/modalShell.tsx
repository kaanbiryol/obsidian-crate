export function hideNativeModalCloseButton(modalEl: HTMLElement): void {
  // Scope native close-control styles to modal shells with a Crate replacement.
  modalEl.addClass("crate-custom-modal-close");
}
