import { expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import type CratePlugin from '@/main';

vi.mock('@/reminders/ui/reminder-list/RemindersList', () => ({ RemindersList: () => null }));
import { RemindersBlockWidget } from './remindersBlockLivePreview';

const block = (completed: boolean) => ['```reminders', 'project: Work', `show-completed: ${completed}`, '```'].join('\n');

function editor(initial: string) {
  let text = initial;
  const view = {
    state: { doc: { sliceString: (from: number, to: number) => text.slice(from, to) } },
    dispatch: vi.fn(({ changes }: { changes: { from: number; to: number; insert: string } }) => {
      text = text.slice(0, changes.from) + changes.insert + text.slice(changes.to);
    }),
  };
  return { view: view as unknown as EditorView & typeof view, setText: (next: string) => { text = next; }, text: () => text };
}

it('re-renders a reminders block only when its options change, not when text above moves it', () => {
  const plugin = {} as CratePlugin;
  const options = { projectFilter: 'Work', showCompleted: false };
  const { view, setText, text } = editor(block(false));
  const render = vi.fn();
  const host = { crateReactRoot: { render }, crateShadowRoot: {} } as unknown as HTMLElement;
  new RemindersBlockWidget(plugin, options, 'Note.md', view, 0, block(false).length).updateDOM(host, view);
  expect(render).toHaveBeenCalledTimes(1);
  const toggle = (render.mock.calls[0]![0] as { props: { children: { props: { onToggleShowCompleted: (value: boolean) => void } } } })
    .props.children.props.onToggleShowCompleted;

  // Typing above the block shifts it without changing what it shows.
  for (const prefix of ['a', 'ab', 'abc']) {
    setText(`${prefix}\n${block(false)}`);
    new RemindersBlockWidget(plugin, options, 'Note.md', view, prefix.length + 1, prefix.length + 1 + block(false).length).updateDOM(host, view);
  }
  expect(render).toHaveBeenCalledTimes(1);

  // The first callback still edits the block at its current position.
  toggle(true);
  expect(text()).toBe(`abc\n${block(true)}`);
  new RemindersBlockWidget(plugin, options, 'Note.md', view, 4, 4 + block(true).length).updateDOM(host, view);
  expect(render).toHaveBeenCalledTimes(2);
});
