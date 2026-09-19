import React, { useContext, useState } from 'react';
import { PageTitleContext } from '@/reminders/components/lexical/pageTitles';
import { RichTextInput } from '@/reminders/components/RichTextInput';


const projects = ['Inbox', 'Work', 'Crate Demo'];
const sample = 'Review [the notes](https://example.com/notes) #Crate Demo ! tomorrow';

export function LexicalTrial() {
  const resolvePageTitle = useContext(PageTitleContext);
  const [lexical, setLexical] = useState(sample);
  const [draft, setDraft] = useState(sample);
  const [readOnly, setReadOnly] = useState(false);
  const [generation, setGeneration] = useState(0);
  const reset = () => { setLexical(draft); };
  return <div className="lexical-trial">
    <header><span className="lexical-trial-eyebrow">Crate / Editor lab</span>
      <h1>Try Lexical</h1>
      <p>Test the shared reminder editor. Try selecting a chip, pasting several lines, and undoing your changes.</p>
    </header>
    <section aria-label="Lexical editor comparison"><h2>Reminder editor</h2>
      <RichTextInput key={generation} readOnly={readOnly} value={lexical} onChange={setLexical} knownProjects={projects} ariaLabel="Lexical reminder" resolvePageTitle={resolvePageTitle} />
      <details open><summary>Reminder text</summary><pre data-testid="lexical-value">{lexical}</pre></details>
    </section>
    <section><h2>Load a reminder</h2>
      <textarea aria-label="Sample reminder" value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="button" onClick={reset}>Load reminder</button>
      <label><input type="checkbox" checked={readOnly} onChange={event => setReadOnly(event.target.checked)} />Read only</label>
      <button type="button" onClick={() => setGeneration(value => value + 1)}>Remount editor</button>
    </section>
    <p className="lexical-trial-note">This screen uses the shared Lexical editor. Sample text here is not saved to your vault.</p>
  </div>;
}
