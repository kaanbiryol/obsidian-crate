import React, { useRef, useState } from 'react';
import type { Reminder } from '@/reminders/types';
import type { RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { ReminderEditorFields } from '@/reminders/ui/reminder-modal/ReminderEditorFields';
import { useReminderDraft } from '@/reminders/ui/reminder-modal/useReminderDraft';
import { buildReminderSubmission } from '@/reminders/ui/reminder-modal/reminderMutation';
import { ProjectPickerContent } from '@/reminders/ui/reminder-modal/ProjectPickerContent';
import { RecurrencePickerModal } from '@/reminders/ui/reminder-modal/RecurrencePickerModal';
import { AddReminderModal } from '@/reminders/ui/reminder-modal/AddReminderModal';
import { PluginContext } from '@/reminders/ui/reminders-context';

const params = new URLSearchParams(location.search);
const reminder = params.has('reminder') ? JSON.parse(params.get('reminder')!) as Reminder : undefined;
const projects = ['Inbox', 'Work'];
const defaultProject = params.get('defaultProject') ?? 'Inbox';
const plugin = { syncRuntime: { getApiClient: () => null } } as unknown as ReturnType<typeof PluginContext.use>;

/** Exercise the real Add/Save buttons, keyboard submission and persistence callbacks. */
export function ReminderModalFixture() {
  const [saved, setSaved] = useState('');
  const [open, setOpen] = useState(true);
  return <main className="crate-reminders-ui reminders-shadow-root">
    {open && <PluginContext.Provider value={plugin}><AddReminderModal reminder={reminder} projects={projects} defaultProject={defaultProject}
      animationConfig={{ enabled: false }} onClose={() => setOpen(false)}
      onAdd={async (content, project, priority, dueDate, recurrence) => {
        setSaved(JSON.stringify({ content, project, priority, dueDate, recurrence }));
      }}
      onSave={async updated => { setSaved(JSON.stringify(updated)); }} /></PluginContext.Provider>}
    <output data-testid="saved">{saved}</output>
  </main>;
}

/** Exercise the plugin's real draft hook and save boundary together. */
export function ReminderDraftFixture() {
  const draft = useReminderDraft({ reminder, projects, defaultProject });
  const textareaRef = useRef<HTMLDivElement>(null);
  const richTextInputRef = useRef<RichTextInputHandle>(null);
  const [saved, setSaved] = useState('');
  const [showProjects, setShowProjects] = useState(false);
  const [showRepeat, setShowRepeat] = useState(false);
  return <main className="crate-reminders-ui reminders-shadow-root">
    <ReminderEditorFields content={draft.content} onContentChange={draft.setContent}
      description={draft.description} onDescriptionChange={draft.setDescription} allowAutoFocus={false}
      projects={projects} textareaRef={textareaRef} richTextInputRef={richTextInputRef} />
    <button onClick={() => setShowProjects(true)}>Choose project</button>
    <button onClick={draft.togglePriority}>Toggle priority</button>
    <button onClick={() => setShowRepeat(true)}>Choose repeat</button>
    <RecurrencePickerModal isOpen={showRepeat} onClose={() => setShowRepeat(false)}
      animationConfig={{ enabled: false }} pickerMode="replace" isDark={false}
      recurrence={draft.recurrence} onApply={rule => draft.applyRecurrenceSelection(rule ?? null)} />
    {showProjects && <ProjectPickerContent isOpen projects={projects} project={draft.project} defaultProject={defaultProject}
      isDark={false} onClose={() => setShowProjects(false)} onSelectProject={draft.applyProjectSelection} />}
    <output data-testid="project">{draft.project}</output>
    <button onClick={() => {
      try {
        setSaved(JSON.stringify(buildReminderSubmission({ ...draft, projects, reminder })));
      } catch (error) {
        setSaved(JSON.stringify({ error: String(error) }));
      }
    }}>Save</button>
    <output data-testid="draft">{JSON.stringify({ content: draft.content, dueDate: draft.dueDate, hasTime: draft.hasTime, recurrence: draft.recurrence })}</output>
    <output data-testid="saved">{saved}</output>
  </main>;
}
