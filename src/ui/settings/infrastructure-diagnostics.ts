import type { DiagnosticResult } from '../../cloudflare/infrastructure';
import { createSettingsSubsectionHeading } from './section-helpers';
import { getDiagnosticStatusPrefix } from './infrastructure-helpers';

export function renderDiagnostics(containerEl: HTMLElement, results: DiagnosticResult[]): void {
	containerEl.show();
	containerEl.empty();
	createSettingsSubsectionHeading(containerEl, 'Diagnostics');

	for (const result of results) {
		const row = containerEl.createDiv({ cls: 'crate-diagnostic-row' });
		row.createEl('p', {
			text: `${getDiagnosticStatusPrefix(result.status)} ${result.name}: ${result.message}`,
			cls: `setting-item-description crate-diagnostic-${result.status}`,
		});
	}
}
