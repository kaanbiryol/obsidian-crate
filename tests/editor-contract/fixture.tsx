import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RichTextInput, type RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { replaceReminderProject, toReminderCursorOffset } from '@/reminders/utils/reminderEditorEdits';
import { parseReminderEditorContent } from '@/reminders/utils/reminderEditorParsing';
import { ReminderDraftFixture, ReminderModalFixture } from './reminder-draft-fixture';
import css from '@/styles/main.scss?inline';

const params = new URLSearchParams(location.search);
function Fixture() {
  const [value, setValue] = useState(params.get('value') ?? '');
  const [other, setOther] = useState('Other reminder');
  const [replacement, setReplacement] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [query, setQuery] = useState<string | null>(null);
  const [projects, setProjects] = useState(['Work', 'Crate Demo']);
  const [focusRequest, setFocusRequest] = useState(0);
  const ref = useRef<RichTextInputHandle>(null);
  const preserveFocus = (event: React.MouseEvent) => event.preventDefault();
  return <main className="crate-reminders-ui reminders-shadow-root">
    <RichTextInput key={generation} ref={ref} value={value} onChange={setValue}
      ariaLabel="Reminder" placeholder="Write a reminder" readOnly={readOnly}
      autoFocus={params.get('autofocus') === 'true'}
      knownProjects={projects} focusRequestKey={focusRequest} syncContentBeforePaint
      onAutocompleteQuery={setQuery}
      onAutocompleteKeyDown={event => {
        if (event.key !== 'Tab' || query !== 'Wo') return false;
        event.preventDefault();
        const next = replaceReminderProject(value, value.lastIndexOf('#Wo'), 3, 'Work', projects);
        ref.current?.setCursorPosition(toReminderCursorOffset(next.text, next.cursor));
        setValue(next.text);
        setQuery(null);
        return true;
      }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); ref.current?.blur(); } }} />
    <pre data-testid="value">{value}</pre><output data-testid="query">{query === null ? '(none)' : query}</output>
    <pre data-testid="parsed">{JSON.stringify(parseReminderEditorContent(value, projects))}</pre>
    <input aria-label="External value" value={replacement} onChange={event => setReplacement(event.target.value)} />
    <button onMouseDown={preserveFocus} onClick={() => setValue(replacement)}>Apply external value</button>
    <button onMouseDown={preserveFocus} onClick={() => { ref.current?.setCursorPosition(2); setValue(replacement); }}>Apply at offset two</button>
    <button onClick={() => ref.current?.focus()}>Focus end</button>
    <button onClick={() => ref.current?.selectAll()}>Select all</button>
    <button onClick={() => ref.current?.blur()}>Blur editor</button>
    <button onClick={() => setFocusRequest(key => key + 1)}>Request focus</button>
    <button onMouseDown={preserveFocus} onClick={() => setProjects(['Work', 'Crate Demo', 'New Project'])}>Add known project</button>
    <label><input type="checkbox" checked={readOnly} onChange={event => setReadOnly(event.target.checked)} />Read only</label>
    <button onClick={() => setGeneration(key => key + 1)}>Remount</button>
    <RichTextInput value={other} onChange={setOther} ariaLabel="Other reminder" syncContentBeforePaint />
    <pre data-testid="other-value">{other}</pre>
  </main>;
}
const container = document.getElementById('app')!;
const root = params.get('host') === 'plugin' ? container.attachShadow({ mode: 'open' }) : container;
const style = document.createElement('style');
// This Sass-only harness does not generate Tailwind's modal positioning utilities.
style.textContent = css + `
  .rich-text-input-editor {min-height: 40px; white-space: pre-wrap;} main {max-width: 500px;}
  .base-modal-container {inset: 0; display: flex; flex-direction: column; justify-content: flex-end;}
  .base-modal-backdrop {position: absolute; inset: 0;}
`;
const mount = document.createElement('div');
root.append(style, mount);
createRoot(mount).render(params.get('fixture') === 'modal' ? <ReminderModalFixture />
  : params.get('fixture') === 'draft' ? <ReminderDraftFixture /> : <Fixture />);
