import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { SettingsAction } from '../settings/SettingsAction';
import { SettingsRow } from '../settings/SettingsRow';
import { downloadJson } from '../storage/download';

/** Stored Reading work leaves the device only after its exact export was saved and reviewed. */
export function ReviewedReadingRemoval({ fileName, exportLabel, load, onRemove }: {
  fileName: string;
  exportLabel: string;
  load: () => Promise<unknown>;
  onRemove: (exported: string) => Promise<boolean>;
}) {
  const [exported, setExported] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Reading storage is unavailable.'); }
    finally { setBusy(false); }
  };
  const exportChanges = () => act(async () => {
    const value = await load();
    downloadJson(fileName, { format: 'crate-reading-review-v1', origin: location.origin, value });
    setExported(JSON.stringify(value)); setReviewed(false);
  });
  const remove = () => act(async () => {
    if (exported === null) return;
    if (!await onRemove(exported)) { setExported(null); setError('These changes changed after the export. Export them again before removing them.'); }
  });
  return <>
    <SettingsAction icon={Download} disabled={busy} onClick={() => void exportChanges()}>{exportLabel}</SettingsAction>
    {exported !== null && <>
      <SettingsRow as="label" title="I saved the export and compared my Reading notes">
        <input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.currentTarget.checked)} />
      </SettingsRow>
      <SettingsAction icon={Trash2} tone="danger" disabled={busy || !reviewed} onClick={() => void remove()}>Remove exported changes from device</SettingsAction>
    </>}
    {error && <p className="settings-attention" role="status">{error}</p>}
  </>;
}
