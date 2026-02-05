/**
 * Configuration and credential management for Crate CLI
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { OAuthTokens } from './cloudflare/oauth.js';

const CONFIG_DIR = join(homedir(), '.crate');
const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json');

export interface StoredCredentials {
	accountId: string;
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

function ensureConfigDir(): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	}
}

export function loadCredentials(): StoredCredentials | null {
	try {
		if (!existsSync(CREDENTIALS_FILE)) {
			return null;
		}

		const content = readFileSync(CREDENTIALS_FILE, 'utf-8');
		const data = JSON.parse(content) as StoredCredentials;

		// Validate required fields
		if (!data.accountId || !data.accessToken) {
			return null;
		}

		return data;
	} catch {
		return null;
	}
}

export function saveCredentials(accountId: string, tokens: OAuthTokens): void {
	ensureConfigDir();

	const credentials: StoredCredentials = {
		accountId,
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: tokens.expiresAt,
	};

	writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), {
		mode: 0o600,
	});
}

export function clearCredentials(): boolean {
	try {
		if (existsSync(CREDENTIALS_FILE)) {
			unlinkSync(CREDENTIALS_FILE);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

export function getConfigDir(): string {
	return CONFIG_DIR;
}

export function getCredentialsPath(): string {
	return CREDENTIALS_FILE;
}

// --- Deployment config (worker name, bucket, etc.) ---

const DEPLOYMENT_FILE = join(CONFIG_DIR, 'deployment.json');

export interface DeploymentConfig {
	workerName: string;
	bucketName: string;
	workerUrl: string;
	databaseId?: string;
}

export function saveDeploymentConfig(config: DeploymentConfig): void {
	ensureConfigDir();
	writeFileSync(DEPLOYMENT_FILE, JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
}

export function clearDeploymentConfig(): boolean {
	try {
		if (existsSync(DEPLOYMENT_FILE)) {
			unlinkSync(DEPLOYMENT_FILE);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

export function loadDeploymentConfig(): DeploymentConfig | null {
	try {
		if (!existsSync(DEPLOYMENT_FILE)) {
			return null;
		}
		const content = readFileSync(DEPLOYMENT_FILE, 'utf-8');
		const data = JSON.parse(content) as DeploymentConfig;
		if (!data.workerName || !data.bucketName) {
			return null;
		}
		return data;
	} catch {
		return null;
	}
}
