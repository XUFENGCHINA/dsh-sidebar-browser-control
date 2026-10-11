/**
 * Pre-publish gate: refuse to publish a package that still contains release
 * placeholders or an incomplete manifest.
 *
 * This runs from `prepublishOnly`, so `npm publish` cannot ship a package whose
 * `repository` points at `github.com/OWNER/...`. Every failure prints the exact
 * file and the fix, because the mistake it catches is invisible on the registry.
 *
 * Run: node scripts/check-release-ready.mjs   (or npm run check:release)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];
const notes = [];

/** Read one repository file as UTF-8. @param name - path relative to the root. @returns text. */
function read(name) {
  return readFileSync(join(root, name), 'utf8');
}

const manifest = JSON.parse(read('package.json'));

if (manifest.private === true) problems.push('package.json sets "private": true — remove it before publishing.');
if (typeof manifest.name !== 'string' || manifest.name.length === 0) problems.push('package.json has no "name".');
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
  problems.push(`package.json version "${String(manifest.version)}" is not a valid semver release version.`);
}
if (typeof manifest.author !== 'string' || manifest.author.length === 0) {
  problems.push('package.json has no "author" — npm shows it on the package page.');
}

const repository = manifest.repository?.url ?? '';
if (repository.length === 0) {
  problems.push('package.json has no "repository.url" — the registry page would have no source link.');
} else if (/OWNER/u.test(repository)) {
  problems.push(`package.json "repository.url" still contains the OWNER placeholder: ${repository}\n    fix: follow step 1 of RELEASING.md.`);
}
for (const field of ['homepage', 'bugs']) {
  const value = JSON.stringify(manifest[field] ?? '');
  if (/OWNER/u.test(value)) problems.push(`package.json "${field}" still contains the OWNER placeholder.`);
}

for (const name of ['README.md', 'README.zh.md']) {
  const text = read(name);
  if (/OWNER/u.test(text)) problems.push(`${name} still contains the OWNER placeholder (badges and links).`);
}

if (!manifest.dsh?.bundle?.patch) problems.push('package.json is missing "dsh.bundle.patch" — DSH could not load it as a bundle.');
if (manifest.dsh?.client?.platform !== 'web') problems.push('package.json must declare "dsh.client.platform": "web".');

try {
  read('LICENSE');
} catch {
  problems.push('LICENSE is missing.');
}

const changelog = read('CHANGELOG.md');
const escaped = manifest.version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
if (!new RegExp(`^## \\[${escaped}\\]`, 'mu').test(changelog)) {
  problems.push(`CHANGELOG.md has no "## [${manifest.version}]" section for this version.`);
}
if (/^## \[Unreleased\]\s*\n\s*(?:###[^\n]*\n\s*)*$/mu.test(changelog) === false) {
  notes.push('CHANGELOG.md still has an empty Unreleased section — fine for a first release.');
}

notes.push(`publishing ${manifest.name}@${manifest.version} (${manifest.license ?? 'no license field'})`);

if (problems.length > 0) {
  console.error('check-release-ready: NOT ready to publish\n');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`\n${problems.length} problem(s). Nothing was published.`);
  process.exit(1);
}

console.log('check-release-ready: OK');
for (const note of notes) console.log(`  · ${note}`);
