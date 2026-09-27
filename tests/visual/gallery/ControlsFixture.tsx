import React, { useState } from 'react';
import { Button } from '@/ui/shared/Button';
import { IconButton } from '@/ui/shared/IconButton';
import { ThemeIcon } from '@/reminders/components/theme-icon';
import { PwaButton } from '@/pwa/components/PwaButton';
import { usePwaInputModality } from '@/pwa/hooks/usePwaInputModality';
import { TextField } from '@/ui/shared/TextField';
import { ViewHeader } from '@/ui/shared/ViewHeader';
import { SettingsSection } from '@/pwa/components/SettingsSection';
import { SettingsRow } from '@/pwa/components/SettingsRow';
import { PwaToast } from '@/pwa/components/PwaToast';
import { useToast } from '@/pwa/hooks/useToast';
import { CopyableText } from '@/ui/shared/CopyableText';
import { PwaNotice } from '@/pwa/components/PwaNotice';

export function ControlsFixture({ host }: { host: 'plugin' | 'pwa' }) {
  usePwaInputModality();
  const [count, setCount] = useState(0);
  const [query, setQuery] = useState('saved article');
  const [copyValue, setCopyValue] = useState('First export');
  const [copyAllowed, setCopyAllowed] = useState(true);
  const { toast, showToast, clearToast } = useToast();
  const activate = () => setCount(value => value + 1);
  return <div className="controls-gallery">
    <h1>Crate controls</h1>
    <p>Quiet outlines, shared states, and room to tap.</p>
    <section aria-label="Standard actions"><h2>Standard actions</h2><div className="controls-gallery__row">
      <Button variant="outline" onClick={activate}>Sync vault</Button>
      <Button variant="outline" onClick={activate}><ThemeIcon id="plus" size="m" aria-hidden="true" />Save your first link</Button>
      <Button variant="outline" disabled onClick={activate}>Unavailable</Button>
    </div></section>
    <section aria-label="Emphasis"><h2>Emphasis</h2><div className="controls-gallery__row">
      <Button variant="primary" onClick={activate}>Save link</Button>
      <Button variant="primary" disabled aria-busy="true" onClick={activate}>Saving…</Button>
      <Button variant="ghost" onClick={activate}>Cancel</Button>
    </div></section>
    <section aria-label="Destructive actions"><h2>Destructive actions</h2><div className="controls-gallery__row">
      <Button variant="outline" tone="danger" onClick={activate}>Remove</Button>
      <Button variant="primary" tone="danger" onClick={activate}>Delete</Button>
      <Button variant="ghost" tone="danger" onClick={activate}>Log out</Button>
    </div></section>
    <section aria-label="Icon actions"><h2>Icon actions</h2><div className="controls-gallery__row">
      <IconButton icon="plus" label="Add" size="large" onClick={activate} />
      <IconButton icon="settings" label="Settings" size="large" onClick={activate} />
      <IconButton icon="trash-2" label="Delete item" size="large" tone="danger" onClick={activate} />
      <IconButton icon="plus" label="Unavailable icon" size="large" disabled onClick={activate} />
    </div></section>
    <section aria-label="Host actions"><h2>Host actions</h2><div className="controls-gallery__row">
      {host === 'plugin' ? <button className="crate-sync-primary-action reminder-modal-header-action" onClick={activate}>Plugin Sync vault</button> : <PwaButton className="settings-action-button" onClick={activate}>Refresh library</PwaButton>}
      <Button variant="outline" size="touch" onClick={activate}>Always a touch target</Button>
      <Button variant="outline" onClick={activate}>Export unsynced reminders and saved changes from this device</Button>
    </div></section>
    <output aria-label="Activations">{count}</output>
    <section aria-label="Plain fields"><h2>Plain fields</h2><div className="controls-gallery__fields">
      <TextField label="Link" type="url" placeholder="https://…" description="A web address to save." leadingIcon={<ThemeIcon id="link" size="m" />} />
      <TextField label="Invalid link" defaultValue="not a link" description="Use an HTTPS address." error="Enter a valid web address." />
      <TextField label="Read-only value" readOnly defaultValue="Select and copy this text" />
      <TextField label="Disabled value" disabled defaultValue="Unavailable" />
      <TextField label="Search controls" hideLabel type="search" leadingIcon={<ThemeIcon id="search" size="m" />} value={query} onChange={event => setQuery(event.target.value)} trailingAction={<IconButton icon="x" size="large" label="Clear control search" onClick={() => setQuery('')} />} />
    </div></section>
    <section aria-label="Copyable values"><h2>Copyable values</h2>
      <CopyableText value={copyValue} label="Export text" copyLabel="Copy export" successMessage="Export copied."
        failureMessage="Select and copy the export below." beforeCopy={() => copyAllowed} />
      <Button variant="outline" onClick={() => setCopyValue('Second export')}>Replace copy value</Button>
      <label><input type="checkbox" checked={copyAllowed} onChange={event => setCopyAllowed(event.currentTarget.checked)} />Allow copying</label>
    </section>
    <section aria-label="Headers"><h2>Headers</h2>
      <div className={`reminders-view is-primary${host === 'pwa' ? ' pwa-reminders-view' : ''}`} data-testid="loaded-header"><ViewHeader title="Reminders" count={2} reserveMetaSpace /></div>
      <div className={`reminders-view is-primary${host === 'pwa' ? ' pwa-opening-screen' : ''}`} data-testid="opening-header"><ViewHeader title="Reminders" count={0} showMeta={false} reserveMetaSpace /></div>
    </section>
    {host === 'pwa' && <>
      <PwaNotice title="Saved changes need review" aria-label="Example recovery" actions={<PwaButton variant="ghost" size="touch" onClick={activate}>Review changes</PwaButton>}>
        <span role="status">Your changes remain on this device.</span>
      </PwaNotice>
      <SettingsSection title="Example preferences"><SettingsRow as="label" title="Default view" description="Select the opening screen."><select defaultValue="reading"><option value="reading">Reading</option><option value="inbox">Inbox</option></select></SettingsRow></SettingsSection>
      <SettingsSection title="Example preferences"><SettingsRow title="Offline storage" description="Available on this device." /></SettingsSection>
      <section aria-label="Feedback"><h2>Feedback</h2><div className="controls-gallery__row">
        <PwaButton onClick={() => showToast('success', 'Changes saved.')}>Show success</PwaButton>
        <PwaButton onClick={() => showToast('error', 'Could not save changes.')}>Show error</PwaButton>
        <PwaButton onClick={clearToast}>Dismiss feedback</PwaButton>
      </div></section>
      <PwaToast toast={toast} />
    </>}
  </div>;
}
