export const CRATE_REPOSITORY_URL = 'https://github.com/kaanbiryol/obsidian-crate';

export function buildCloudflareDeployUrl(repositoryUrl: string = CRATE_REPOSITORY_URL): string {
	const url = new URL('https://deploy.workers.cloudflare.com/');
	url.searchParams.set('url', repositoryUrl);
	return url.toString();
}

export const CRATE_CLOUDFLARE_DEPLOY_URL = buildCloudflareDeployUrl();
