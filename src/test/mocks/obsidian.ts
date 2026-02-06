export class TFolder {
	path: string;

	constructor(path = '') {
		this.path = path;
	}
}

export class Notice {
	constructor(_message?: string) {}
}

export const Platform = {
	isDesktopApp: true,
};

export async function requestUrl(): Promise<never> {
	throw new Error('requestUrl mock not implemented for this test');
}
