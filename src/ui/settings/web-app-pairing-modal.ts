import { createModalActions, createModalFooter } from '../shared/modal-elements';
import type { Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { SharedModal } from '../shared/SharedModal';
import { openWebAppPairing } from '../../plugin/web-app-pairing';
import { answerAppPairing } from '../../encryption/pairing/session';
import { PairingEndedError } from '../../encryption/pairing/protocol';

export class WebAppPairingModal extends SharedModal {
  private readonly controller = new AbortController();
  private timer?: number;
  private cancel?: (id: string) => Promise<void>;
  private attempt?: Awaited<ReturnType<typeof answerAppPairing>>;
  private approved = false;
  private approving = false;
  constructor(private readonly plugin: CratePlugin) { super(plugin.app); }
  onOpen(): void {
    this.openLayout('Connect web app');
    this.modalEl.addClass('crate-encryption-modal', 'crate-web-pairing-modal');
    const status = this.bodyEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const heading = status.createEl('h3', { cls: 'crate-encryption-operation__title', text: 'Waiting for your app…' });
    const instructions = status.createEl('p', { cls: 'crate-encryption-intro', text: 'Open Crate on your phone and select ' });
    instructions.createEl('strong', { text: 'Connect with Obsidian' }); instructions.appendText('.');
    const codePanel = this.bodyEl.createDiv({ cls: 'crate-web-pairing-verification' });
    codePanel.createSpan({ text: 'Verification code' });
    const code = codePanel.createEl('output', { cls: 'crate-web-pairing-code', attr: { 'aria-label': 'Verification code' } });
    codePanel.hidden = true;
    const actions = createModalFooter(this.contentEl);
    actions.addClass('crate-encryption-footer');
    const addCancel = (setting: Setting) => setting.addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));
    addCancel(createModalActions(actions));
    const showError = (error: unknown) => {
      if (this.controller.signal.aborted) return;
      heading.setText('Couldn’t connect');
      instructions.setText(error instanceof Error ? error.message : 'Could not connect. Try again.');
    };
    void (async () => {
      const connection = await openWebAppPairing(this.plugin, this.controller.signal);
      this.cancel = id => connection.cancel(id);
      let polling = false;
      const deadline = Date.now() + 5 * 60_000;
      const poll = async () => {
        if (polling || this.approving || this.approved || this.controller.signal.aborted) return;
        polling = true;
        try {
          connection.current();
          if (Date.now() >= deadline) throw new Error('Pairing timed out. Close this screen and start again.');
          if (document.hidden) { this.timer = window.setTimeout(() => { void poll(); }, 2500); return; }
          if (!this.attempt) {
            const requests = (await connection.transport.read()).requests;
            connection.current();
            const request = requests.filter(item => !item.closed && !item.responderKey).sort((a, b) => b.expiresAt - a.expiresAt)[0];
            if (request) {
              connection.validate(request.context);
              this.attempt = await answerAppPairing(request, connection.transport, connection.current);
            }
          }
          const verification = await this.attempt?.poll();
          if (this.approving || this.approved) return;
          if (verification && this.attempt) {
            heading.setText('Compare codes');
            instructions.setText('Only approve if this code matches the one on your phone.');
            code.setText(verification);
            const firstCode = codePanel.hidden;
            codePanel.hidden = false;
            if (firstCode) {
              actions.empty();
              addCancel(createModalActions(actions)).addButton(button => button.setButtonText('Approve').setCta().onClick(async () => {
                button.setDisabled(true);
                this.approving = true;
                window.clearTimeout(this.timer);
                try {
                  const attempt = this.attempt!;
                  const payload = await connection.payload(attempt.context);
                  connection.current();
                  await attempt.approve(payload);
                  this.approved = true;
                  heading.setText('Finish on your phone');
                  instructions.setText('If the code matches, select ');
                  instructions.createEl('strong', { text: 'Confirm and unlock' });
                  instructions.appendText(' on your phone.');
                  actions.empty();
                  createModalActions(actions).addButton(done => done.setButtonText('Done').onClick(() => this.close()));
                } catch (error) { showError(error); button.setDisabled(false); }
                finally { this.approving = false; }
              }));
            }
          }
          this.timer = window.setTimeout(() => { void poll(); }, 2500);
        } catch (error) {
          if (this.controller.signal.aborted || this.approving || this.approved) return;
          showError(error); codePanel.hidden = true; actions.empty();
          if (error instanceof PairingEndedError) this.attempt = undefined;
          addCancel(createModalActions(actions)).addButton(button => button.setButtonText('Try again').onClick(() => {
            actions.empty(); addCancel(createModalActions(actions)); void poll();
          }));
        }
        finally { polling = false; }
      };
      await poll();
    })().catch(showError);
  }
  onClose(): void {
    if (!this.approved && this.attempt) void this.cancel?.(this.attempt.id).catch(() => {});
    this.controller.abort(); window.clearTimeout(this.timer);
    this.attempt = undefined;
    super.onClose();
  }
}
