import { Tabs } from '@base-ui/react/tabs';
import type { RecurrenceRule } from '../../types';
import { RECURRENCE_FREQUENCIES, RECURRENCE_FREQUENCY_LABELS } from './recurrencePickerShared';

export function RecurrenceFrequencyTabs({ frequency }: { frequency: RecurrenceRule['frequency'] }) {
    return <Tabs.List className="recurrence-frequency-tabs" aria-label="Repeat frequency" activateOnFocus>
        {RECURRENCE_FREQUENCIES.map(freq => <Tabs.Tab
            key={freq} value={freq}
            className={`recurrence-frequency-button${frequency === freq ? ' is-selected' : ''}`}
        >{RECURRENCE_FREQUENCY_LABELS[freq]}</Tabs.Tab>)}
    </Tabs.List>;
}
