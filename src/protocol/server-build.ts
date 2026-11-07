/** Worker, database and bucket names Crate creates: `crate-` and the 16-digit deployment ID. */
export const CRATE_RESOURCE_NAME = /^crate-([a-f0-9]{16})$/;
export const isCrateResourceName = (value: string): boolean => CRATE_RESOURCE_NAME.test(value);

/** Development identities never change the public server revision. */
export interface DevelopmentBuild {
	number: number;
	worker: string;
}

declare const __CRATE_DEVELOPMENT_BUILD__: DevelopmentBuild | undefined;
export const DEVELOPMENT_BUILD = typeof __CRATE_DEVELOPMENT_BUILD__ === 'undefined' ? undefined : __CRATE_DEVELOPMENT_BUILD__;

export function parseDevelopmentBuild(value: unknown): DevelopmentBuild | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const build = value as Partial<DevelopmentBuild>;
	return Number.isSafeInteger(build.number) && Number(build.number) > 0
		&& typeof build.worker === 'string' && isCrateResourceName(build.worker)
		? { number: Number(build.number), worker: build.worker } : undefined;
}

export function serverBuildLabel(revision: number, build?: DevelopmentBuild): string {
	return `${revision}${build ? `-dev.${build.number}` : ''}`;
}

export function canReplaceServerBuild(
	saved: { revision: number; fingerprint: string; development?: DevelopmentBuild },
	next: { revision: number; fingerprint: string; development?: DevelopmentBuild },
): boolean {
	if (next.revision < saved.revision) return false;
	if (next.revision > saved.revision) return true;
	if (next.fingerprint === saved.fingerprint) return true;
	if (!saved.development) return false;
	if (!next.development) return true;
	return saved.development.worker === next.development.worker && next.development.number > saved.development.number;
}
