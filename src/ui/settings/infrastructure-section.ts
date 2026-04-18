import { renderInfrastructureManagementSection } from './infrastructure-management-section';
import { renderInfrastructureSyncActions } from './infrastructure-sync-actions';
import type { InfrastructureSectionContext } from './infrastructure-types';
import { createSettingsSectionHeading } from './section-helpers';

export function renderInfrastructureSection(context: InfrastructureSectionContext): void {
	const { containerEl } = context;
	createSettingsSectionHeading(containerEl, 'Advanced');
	renderInfrastructureSyncActions(context);
	renderInfrastructureManagementSection(context);
}
export type { InfrastructureSectionContext } from './infrastructure-types';
