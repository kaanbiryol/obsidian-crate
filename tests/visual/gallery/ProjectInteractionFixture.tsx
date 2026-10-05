import { useRef, useState } from 'react';
import { AddReminderModal } from '@/reminders/ui/reminder-modal/AddReminderModal';
import { ProjectPickerContent } from '@/reminders/ui/reminder-modal/ProjectPickerContent';
import { ReminderEditorFields } from '@/reminders/ui/reminder-modal/ReminderEditorFields';
import type { RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { PluginContext } from '@/reminders/ui/reminders-context';

const projects = Array.from({ length: 36 }, (_, index) => `Project ${String(index + 1).padStart(2, '0')}`);
const plugin = { syncRuntime: { getApiClient: () => null } } as unknown as ReturnType<typeof PluginContext.use>;

/** Constrained, scrollable hosts around the real controls and compiled host CSS. */
export function ProjectInteractionFixture({ host, isDark }: { host: 'plugin' | 'pwa'; isDark: boolean }) {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  const [project, setProject] = useState('Project 18');
  const [open, setOpen] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [gestures, setGestures] = useState({ wheel: 0, touch: 0 });
  const titleRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<RichTextInputHandle>(null);
  return <>
    <div data-testid="picker-ancestor" style={{ height: 'calc(100dvh - 96px)', overflow: 'auto' }}
      onWheel={() => setGestures(value => ({ ...value, wheel: value.wheel + 1 }))}
      onTouchMove={() => setGestures(value => ({ ...value, touch: value.touch + 1 }))}>
      <div style={{ height: 96 }} />
      {mode === 'overlay' ? open && <PluginContext.Provider value={plugin}><AddReminderModal onClose={() => setOpen(false)} projects={projects}
        defaultProject={project} pickerMode="overlay" variant="centered" animationConfig={{ enabled: false }} /></PluginContext.Provider>
        : mode === 'autocomplete' ? <section data-testid="picker-surface"
          className={host === 'plugin' ? 'base-modal-surface crate-reminder-editor-surface' : 'modal-card pwa-reminder-editor'}
          style={{ position: 'relative', height: 540, width: '100%', maxWidth: 560, margin: '0 auto', padding: 18 }}>
          <div style={{ height: params.get('placement') === 'top' ? 400 : 0 }} />
          <ReminderEditorFields content={title} onContentChange={setTitle} description={description} onDescriptionChange={setDescription}
            allowAutoFocus={false} projects={projects} textareaRef={titleRef} richTextInputRef={inputRef} />
        </section>
        : open && <section data-testid="picker-surface"
          className={host === 'plugin' ? 'base-modal-surface crate-reminder-picker-surface is-project-picker' : 'pwa-picker-sheet pwa-project-picker-sheet'}
          style={{ width: '100%', maxWidth: 380, maxHeight: 420, margin: '0 auto' }}>
          <ProjectPickerContent isOpen projects={projects} project={project} defaultProject="Project 01" isDark={isDark}
            onSelectProject={setProject} onClose={() => setOpen(false)} />
        </section>}
      <div style={{ height: 1200 }} />
    </div>
    <output aria-label="Selected project">{project}</output>
    <output aria-label="Ancestor gestures">{gestures.wheel},{gestures.touch}</output>
  </>;
}
