// Shared keyboard helpers: text-input detection and a module-level "a modal
// (palette / cheatsheet) is open" flag the Player's hotkey handler checks so
// modal overlays own the keyboard while visible.

export function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    // checkboxes etc. are not text inputs — hotkeys still apply
    return !["checkbox", "radio", "button", "range", "submit"].includes(type);
  }
  return false;
}

// Counted (palette + cheatsheet can overlap during transitions).
let modalCount = 0;

export function setModalOpen(on: boolean): void {
  modalCount = Math.max(0, modalCount + (on ? 1 : -1));
}

export function isModalOpen(): boolean {
  return modalCount > 0;
}
