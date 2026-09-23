import { CRATE_PLUGIN_PROTOCOL } from '@/protocol';
import { Modal, Notice, Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { readingServerRequest } from '../server';

/** Capture credentials are displayed once and never copied into browser enrollment links. */
export class ReadingPhoneSetup extends Modal {
  constructor(private plugin: CratePlugin) { super(plugin.app); }
  onOpen() {
    this.titleEl.setText('Save to Crate on iPhone');
    this.contentEl.createEl('p', { text: 'On iOS 27 or later, use the web app on your iPhone to download and pair the shortcut.' });
    new Setting(this.contentEl).setName('Set up in the web app').setDesc('Copy this setup link to your iPhone. It connects reading and opens shortcut setup; use it within 10 minutes.')
      .addButton(button => button.setButtonText('Copy phone setup link').setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          const access = await readingServerRequest<{ url: string }>(this.plugin, '/reading/access', { kind: 'reading' });
          const url = new URL(access.url); url.searchParams.set('setup', 'shortcut');
          await navigator.clipboard.writeText(url.href); new Notice('Phone setup link copied. Open it on your iPhone.');
        } catch (error) { new Notice(error instanceof Error ? error.message : 'Could not create a phone setup link.'); }
        finally { button.setDisabled(false); }
      }));
    this.contentEl.createEl('h3', { text: 'Manual setup for older shortcuts' });
    const setup = this.contentEl.createEl('p');
    setup.appendText('For an existing manual-setup copy of ');
    setup.createEl('strong', { text: 'Save to Crate (iOS 27)' });
    setup.appendText(', run it once from your shortcut library. Paste the endpoint and authorization header when asked. It remembers them for future shares; run it from your library again to change the setup. The older template asks for these values during installation. The capture credential can save links but cannot read your vault or reading library.');
    this.contentEl.createEl('p', { text: 'To build your own shortcut, follow these steps and enable it in the share sheet for URLs and web pages.' });
    const steps = this.contentEl.createEl('ol');
    for (const text of [
      'Add Get URLs from Shortcut Input, then Get Item from List → First Item.',
      'Add Get Contents of URL using the endpoint below. Set Method to POST and Request Body to JSON. Add a text field named url and select First Item as its value.',
      `Add the Authorization header shown below and X-Crate-Protocol with value ${CRATE_PLUGIN_PROTOCOL.current}.`,
      'Add Get Dictionary Value → launchUrl from Contents of URL, then Show Web View using that value. Keep reader mode off.',
      'Share a link, select Save to Crate, and wait for the Crate sheet to confirm Saved. Keep the sheet open to retry an interrupted save, then dismiss it when finished.',
    ]) steps.createEl('li', { text });
    this.contentEl.createEl('p', { text: 'Your server must be reachable over HTTPS. This first iPhone flow needs an internet connection. The access token expires after 90 days; remove it in Crate’s connected devices to revoke it sooner.' });
    const output = this.contentEl.createDiv();
    new Setting(this.contentEl).setName('Shortcut access').setDesc('Create a separate capture credential for this phone.')
      .addButton(button => button.setButtonText('Create shortcut access').setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          const access = await readingServerRequest<{ token: string; endpoint: string }>(this.plugin, '/reading/access', { kind: 'capture' });
          output.empty();
          new Setting(output).setName('Endpoint').addText(text => { text.setValue(access.endpoint); text.inputEl.readOnly = true; })
            .addButton(copy => copy.setButtonText('Copy endpoint').onClick(() => { void navigator.clipboard.writeText(access.endpoint); }));
          new Setting(output).setName('Authorization header').addText(text => { text.setValue(`Bearer ${access.token}`); text.inputEl.type = 'password'; text.inputEl.readOnly = true; })
            .addButton(copy => copy.setButtonText('Copy header').onClick(() => { void navigator.clipboard.writeText(`Bearer ${access.token}`); }));
        } catch (error) { new Notice(error instanceof Error ? error.message : 'Could not create shortcut access.'); button.setDisabled(false); }
      }));
  }
  onClose() { this.contentEl.empty(); }
}
