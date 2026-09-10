import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const outputPath = path.join(projectRoot, 'THIRD_PARTY_NOTICES.md');
const checkOnly = process.argv.includes('--check');

const fallbackLicenseText = {
	MIT: `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
	ISC: `ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
	'0BSD': `BSD Zero Clause License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
};

function normalizeText(value) {
	return value.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function escapeTableCell(value) {
	return String(value).replace(/\|/g, '\\|');
}

async function readPackageLicense(packageDirectory, declaredLicense, author) {
	const entries = await readdir(packageDirectory, { withFileTypes: true });
	const licenseFiles = entries
		.filter(entry => entry.isFile() && /^(licen[cs]e|copying|notice)(?:\.|$)/i.test(entry.name))
		.map(entry => entry.name)
		.sort((left, right) => left.localeCompare(right));

	if (licenseFiles.length > 0) {
		return await Promise.all(licenseFiles.map(async fileName => ({
			fileName,
			text: normalizeText(await readFile(path.join(packageDirectory, fileName), 'utf8')),
		})));
	}

	const fallback = fallbackLicenseText[declaredLicense];
	if (!fallback) {
		throw new Error(`No license file or fallback text found in ${packageDirectory} (${declaredLicense})`);
	}
	const copyright = author ? `Copyright (c) ${author}\n\n` : '';
	return [{ fileName: `${declaredLicense}.txt`, text: `${copyright}${fallback}` }];
}

async function createNotices() {
	const lockfile = JSON.parse(await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'));
	const packages = [];

	for (const [packagePath, lockEntry] of Object.entries(lockfile.packages ?? {})) {
		if (!packagePath.startsWith('node_modules/') || lockEntry.dev || lockEntry.link) {
			continue;
		}

		const packageDirectory = path.join(projectRoot, packagePath);
		const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
		const declaredLicense = lockEntry.license ?? manifest.license;
		if (typeof declaredLicense !== 'string' || declaredLicense.length === 0) {
			throw new Error(`Missing declared license for ${manifest.name ?? packagePath}`);
		}

		const author = typeof manifest.author === 'string'
			? manifest.author
			: manifest.author?.name;
		packages.push({
			name: manifest.name,
			version: lockEntry.version ?? manifest.version,
			declaredLicense,
			licenses: await readPackageLicense(packageDirectory, declaredLicense, author),
		});
	}

	packages.sort((left, right) => left.name.localeCompare(right.name));
	const lines = [
		'# Third-party notices',
		'',
		'This file lists the production dependencies recorded in `package-lock.json` and reproduces the license or notice files distributed with them. It is generated by `npm run notices:generate`; edit the dependency metadata rather than this file.',
		'',
		'| Package | Version | Declared license |',
		'| --- | --- | --- |',
		...packages.map(item => `| ${escapeTableCell(item.name)} | ${escapeTableCell(item.version)} | ${escapeTableCell(item.declaredLicense)} |`),
		'',
	];

	for (const item of packages) {
		lines.push(`## ${item.name}@${item.version}`, '', `Declared license: ${item.declaredLicense}`, '');
		for (const license of item.licenses) {
			lines.push(`### ${license.fileName}`, '', '```text', license.text, '```', '');
		}
	}

	return `${lines.join('\n').trim()}\n`;
}

const notices = await createNotices();
if (checkOnly) {
	let current = '';
	try {
		current = await readFile(outputPath, 'utf8');
	} catch {
		// The comparison below provides the actionable error.
	}
	if (current !== notices) {
		throw new Error('THIRD_PARTY_NOTICES.md is out of date. Run npm run notices:generate.');
	}
	console.log('Third-party notices are up to date.');
} else {
	await writeFile(outputPath, notices);
	console.log('Wrote THIRD_PARTY_NOTICES.md.');
}
