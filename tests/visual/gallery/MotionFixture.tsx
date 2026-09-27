import { useState } from 'react';
import { Button } from '@/ui/shared/Button';
import { BaseModal } from '@/reminders/components/BaseModal';
import { EmptyState } from '@/reminders/components/EmptyState';
import { ProgressMeter } from '@/reminders/components/ProgressMeter';
import { ReminderCard } from '@/reminders/components/ReminderCard';
import { ReminderListLayout } from '@/reminders/ui/views/ReminderListLayout';

export function MotionFixture({ host }: { host: 'plugin' | 'pwa' }) {
  const [hasContent, setHasContent] = useState(false);
  const [activations, setActivations] = useState(0);
  const [open, setOpen] = useState(false);
  const [complete, setComplete] = useState(false);
  return <div className="motion-fixture">
    <Button data-motion-toggle onClick={() => setHasContent(value => !value)}>Toggle list</Button>
    <Button onClick={() => setOpen(value => !value)}>Toggle dialog</Button>
    <Button onClick={() => setComplete(value => !value)}>Toggle completion</Button>
    <output aria-label="List activations">{activations}</output>
    <ProgressMeter percentage={complete ? 100 : 25} label="Project completion" />
    <ReminderCard reminder={{ id: 'motion', content: 'Check this reminder', completed: complete, project: 'Inbox' }} />
    <div style={{ height: 320 }}>
      <ReminderListLayout hasContent={hasContent} hasFab={false} animationConfig={{ enabled: true }} renderCard={() => null}
        emptyState={<EmptyState icon="inbox" title="No reminders" description="Add your first reminder." />}>
        <Button data-live-action onClick={() => setActivations(value => value + 1)}>Open reminder</Button>
      </ReminderListLayout>
    </div>
    {host === 'plugin' && <BaseModal variant="centered" isOpen={open} ariaLabel="Motion dialog" onClose={() => setOpen(false)}>
      <p>Dialog content stays still.</p><Button onClick={() => setOpen(false)}>Close dialog</Button>
    </BaseModal>}
  </div>;
}
