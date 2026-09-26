import React, { useState } from 'react';
import { Button } from '@/ui/shared/Button';
import { IconButton } from '@/ui/shared/IconButton';
import { ThemeIcon } from '@/reminders/components/theme-icon';
import { PwaButton } from '@/pwa/components/PwaButton';
import { usePwaInputModality } from '@/pwa/hooks/usePwaInputModality';

export function ControlsFixture({ host }: { host: 'plugin' | 'pwa' }) {
  usePwaInputModality();
  const [count, setCount] = useState(0);
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
  </div>;
}
