import { groupDiffContext, type DiffLine } from './diff-model';

type DiffTextRenderer = (container: HTMLElement, line: DiffLine) => void;

export function renderDiffText(container: HTMLElement, text: string, words?: DiffLine['words']): void {
	if (words) {
		for (const word of words) container.createSpan({ text: word.text, cls: word.changed ? 'crate-diff-word' : '' });
	} else container.setText(text || ' ');
}

function renderLine(container: HTMLElement, line: DiffLine, renderText?: DiffTextRenderer): void {
	const row = container.createDiv({ cls: `crate-diff-line is-${line.kind}` });
	row.createSpan({ text: line.before?.toString() ?? '', cls: 'crate-diff-number', attr: { 'aria-hidden': 'true' } });
	row.createSpan({ text: line.after?.toString() ?? '', cls: 'crate-diff-number', attr: { 'aria-hidden': 'true' } });
	row.createSpan({ text: line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ', cls: 'crate-diff-sign' });
	const text = row.createEl('code', { cls: 'crate-diff-text' });
	if (renderText) renderText(text, line);
	else renderDiffText(text, line.text, line.words);
}

export function renderDiffLines(container: HTMLElement, lines: DiffLine[], label: string, renderText?: DiffTextRenderer): HTMLElement {
	const code = container.createDiv({ cls: 'crate-diff-code', attr: { tabindex: '0', role: 'region', 'aria-label': label } });
	for (const group of groupDiffContext(lines)) {
		if (!group.hidden) {
			for (const line of group.lines) renderLine(code, line, renderText);
			continue;
		}
		const gap = code.createDiv({ cls: 'crate-diff-gap' });
		const expand = gap.createEl('button', { text: `··· ${group.lines.length} unchanged lines ···`, attr: { type: 'button', 'aria-label': `Show ${group.lines.length} unchanged lines` } });
		expand.addEventListener('click', () => {
			gap.empty();
			for (const line of group.lines) renderLine(gap, line, renderText);
			code.focus({ preventScroll: true });
		});
	}
	return code;
}

export const diffCountsLabel = ({ added, removed }: { added: number; removed: number }) => `${added} added lines, ${removed} removed lines`;

/** The `+added −removed` line counts beside a comparison. `labelEach` names each count
 * for assistive technology when no surrounding element carries `diffCountsLabel`. */
export function renderDiffCounts(container: HTMLElement, { added, removed }: { added: number; removed: number }, labelEach = false): void {
	container.createSpan({ text: `+${added}`, cls: 'is-added', ...labelEach ? { attr: { 'aria-label': `${added} added lines` } } : {} });
	container.createSpan({ text: `−${removed}`, cls: 'is-removed', ...labelEach ? { attr: { 'aria-label': `${removed} removed lines` } } : {} });
}
