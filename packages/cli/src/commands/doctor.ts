/**
 * `crate doctor` command - Diagnostic tool for Obsidian Crate setup
 */

import inquirer from 'inquirer';
import { CloudflareCredentials, verifyCredentials, listR2Buckets, getWorkerSubdomain } from '../cloudflare/api.js';

export interface DoctorOptions {
	workerUrl?: string;
	token?: string;
	accountId?: string;
	apiToken?: string;
}

interface DiagnosticResult {
	name: string;
	status: 'pass' | 'fail' | 'warn';
	message: string;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
	console.log('\n🩺 Obsidian Crate - Diagnostics\n');

	const results: DiagnosticResult[] = [];

	// Check 1: Worker connectivity
	if (options.workerUrl && options.token) {
		console.log('Checking worker connectivity...');
		const workerCheck = await checkWorkerHealth(options.workerUrl, options.token);
		results.push(workerCheck);
	} else {
		// Interactive mode
		const answers = await inquirer.prompt<{ workerUrl: string; token: string }>([
			{
				type: 'input',
				name: 'workerUrl',
				message: 'Worker URL:',
				validate: (input: string) => {
					try {
						new URL(input);
						return true;
					} catch {
						return 'Please enter a valid URL';
					}
				},
			},
			{
				type: 'password',
				name: 'token',
				message: 'Auth Token:',
				validate: (input: string) => input.length > 0 || 'Token is required',
			},
		]);

		console.log('\nRunning diagnostics...\n');

		const workerCheck = await checkWorkerHealth(answers.workerUrl, answers.token);
		results.push(workerCheck);

		if (workerCheck.status === 'pass') {
			// Check manifest endpoint
			const manifestCheck = await checkManifest(answers.workerUrl, answers.token);
			results.push(manifestCheck);
		}
	}

	// Check Cloudflare credentials if provided
	if (options.accountId && options.apiToken) {
		console.log('Checking Cloudflare credentials...');
		const credentials: CloudflareCredentials = {
			accountId: options.accountId,
			apiToken: options.apiToken,
		};

		const credCheck = await checkCloudflareCredentials(credentials);
		results.push(credCheck);

		if (credCheck.status === 'pass') {
			const bucketCheck = await checkR2Buckets(credentials);
			results.push(bucketCheck);
		}
	}

	// Output results
	console.log('\n' + '═'.repeat(60));
	console.log('Diagnostic Results:');
	console.log('─'.repeat(60) + '\n');

	for (const result of results) {
		const icon = result.status === 'pass' ? '✅' : result.status === 'warn' ? '⚠️' : '❌';
		console.log(`${icon} ${result.name}`);
		console.log(`   ${result.message}\n`);
	}

	const failCount = results.filter(r => r.status === 'fail').length;
	const warnCount = results.filter(r => r.status === 'warn').length;

	if (failCount === 0 && warnCount === 0) {
		console.log('🎉 All checks passed! Your setup looks good.\n');
	} else if (failCount === 0) {
		console.log(`⚠️  ${warnCount} warning(s) found. Review the messages above.\n`);
	} else {
		console.log(`❌ ${failCount} check(s) failed. Please fix the issues above.\n`);
		process.exit(1);
	}
}

async function checkWorkerHealth(workerUrl: string, token: string): Promise<DiagnosticResult> {
	try {
		const response = await fetch(`${workerUrl}/health`, {
			headers: {
				'Authorization': `Bearer ${token}`,
			},
		});

		if (response.ok) {
			const data = await response.json() as { status: string; timestamp: string };
			return {
				name: 'Worker Health',
				status: 'pass',
				message: `Worker is responding. Status: ${data.status}`,
			};
		} else if (response.status === 401) {
			return {
				name: 'Worker Health',
				status: 'fail',
				message: 'Authentication failed. Check your auth token.',
			};
		} else {
			return {
				name: 'Worker Health',
				status: 'fail',
				message: `Worker returned status ${response.status}`,
			};
		}
	} catch (error) {
		return {
			name: 'Worker Health',
			status: 'fail',
			message: `Cannot connect to worker: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}

async function checkManifest(workerUrl: string, token: string): Promise<DiagnosticResult> {
	try {
		const response = await fetch(`${workerUrl}/sync/manifest`, {
			headers: {
				'Authorization': `Bearer ${token}`,
			},
		});

		if (response.ok) {
			const data = await response.json() as { version: number; files: Record<string, unknown> };
			const fileCount = Object.keys(data.files || {}).length;
			return {
				name: 'Manifest Access',
				status: 'pass',
				message: `Manifest accessible. ${fileCount} file(s) tracked.`,
			};
		} else {
			return {
				name: 'Manifest Access',
				status: 'fail',
				message: `Cannot access manifest: ${response.status}`,
			};
		}
	} catch (error) {
		return {
			name: 'Manifest Access',
			status: 'fail',
			message: `Error accessing manifest: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}

async function checkCloudflareCredentials(credentials: CloudflareCredentials): Promise<DiagnosticResult> {
	const valid = await verifyCredentials(credentials);
	return {
		name: 'Cloudflare Credentials',
		status: valid ? 'pass' : 'fail',
		message: valid ? 'API token is valid' : 'API token verification failed',
	};
}

async function checkR2Buckets(credentials: CloudflareCredentials): Promise<DiagnosticResult> {
	try {
		const buckets = await listR2Buckets(credentials);
		const crateBuckets = buckets.filter(b => b.name.startsWith('crate-'));
		return {
			name: 'R2 Buckets',
			status: 'pass',
			message: `Found ${buckets.length} bucket(s), ${crateBuckets.length} Crate bucket(s)`,
		};
	} catch (error) {
		return {
			name: 'R2 Buckets',
			status: 'fail',
			message: `Cannot list buckets: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}
