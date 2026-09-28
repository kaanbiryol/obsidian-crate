import React, { useId } from 'react';
import { readingUrl } from '../core/model';
import { ReadingDialog, type ReadingDialogProps } from './ReadingDialog';
import { SaveLinkForm } from './SaveLinkForm';

/** Plugin capture uses the same header action and native field as the reminder editor. */
export function SaveLinkDialog({ url, onUrl, saving, error, onSave, onClose, variant, showBackdrop }: {
  url: string;
  onUrl: (value: string) => void;
  saving: boolean;
  error?: string | null;
  onSave: () => void;
  onClose: () => void;
  variant?: ReadingDialogProps['variant'];
  showBackdrop?: boolean;
}) {
  const formId = useId();
  let canSave = false;
  try { readingUrl(url); canSave = !saving; } catch { /* Keep Save disabled until the link is valid. */ }
  return <ReadingDialog title="Save a link" variant={variant} showBackdrop={showBackdrop} busy={saving} onClose={onClose}
    action={{ label: 'Save', ariaLabel: 'Save link', type: 'submit', form: formId, disabled: !canSave, busy: saving }}>
    <SaveLinkForm id={formId} headerAction rounded={false} url={url} onUrl={onUrl} saving={saving} error={error}
      onCancel={onClose} onSave={() => { if (canSave) onSave(); }} />
  </ReadingDialog>;
}
