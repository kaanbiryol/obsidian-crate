import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RichTextInput, type RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { toReminderCursorOffset } from '@/reminders/utils/reminderEditorEdits';
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
        const next = value.replace(/#Wo$/, '#Work ');
        ref.current?.setCursorPosition(toReminderCursorOffset(next, next.length));
        setValue(next);
        setQuery(null);
        return true;
      }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); ref.current?.blur(); } }} />
    <pre data-testid="value">{value}</pre><output data-testid="query">{query === null ? '(none)' : query}</output>
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
style.textContent = css + '\n.rich-text-input-editor {min-height: 40px; white-space: pre-wrap;} main {max-width: 500px;}';
const mount = document.createElement('div');
root.append(style, mount);
createRoot(mount).render(<Fixture />);
