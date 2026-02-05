/**
 * Obsidian Crate CLI
 * Setup and manage Cloudflare infrastructure for vault syncing
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';

const program = new Command();

program
	.name('crate')
	.description('CLI tool for setting up Obsidian Crate sync infrastructure')
	.version('1.0.0');

program
	.command('init')
	.description('Initialize Cloudflare infrastructure (R2 bucket + Worker)')
	.option('--account-id <id>', 'Cloudflare Account ID')
	.option('--api-token <token>', 'Cloudflare API Token')
	.option('--bucket-name <name>', 'Custom R2 bucket name')
	.option('--worker-name <name>', 'Custom Worker name')
	.action(async (options) => {
		await initCommand({
			accountId: options.accountId,
			apiToken: options.apiToken,
			bucketName: options.bucketName,
			workerName: options.workerName,
		});
	});

program
	.command('doctor')
	.description('Diagnose and verify your Obsidian Crate setup')
	.option('--worker-url <url>', 'Worker URL to test')
	.option('--token <token>', 'Auth token')
	.option('--account-id <id>', 'Cloudflare Account ID (for advanced checks)')
	.option('--api-token <apiToken>', 'Cloudflare API Token (for advanced checks)')
	.action(async (options) => {
		await doctorCommand({
			workerUrl: options.workerUrl,
			token: options.token,
			accountId: options.accountId,
			apiToken: options.apiToken,
		});
	});

program
	.command('login')
	.description('Authenticate with Cloudflare via browser')
	.action(async () => {
		await loginCommand();
	});

program
	.command('logout')
	.description('Clear stored Cloudflare credentials')
	.action(async () => {
		await logoutCommand();
	});

program.parse();
