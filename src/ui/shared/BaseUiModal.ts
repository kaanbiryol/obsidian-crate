import { Modal, Scope, type App } from 'obsidian';

/** Keep Obsidian's window/history shell while Base UI owns focus and dismissal. */
export abstract class BaseUiModal extends Modal {
    hasInitialInputFocus = false;

    constructor(app: App) {
        super(app);
        // The native scope handles Escape during window capture, before React can
        // dismiss a nested picker or reject closing a pending save. A fresh scope
        // also avoids running Obsidian's focus trap alongside Base UI's trap.
        this.scope = new Scope();
    }
}
