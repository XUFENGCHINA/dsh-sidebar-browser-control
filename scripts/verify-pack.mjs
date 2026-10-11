/**
 * Release gate: prove the *published* artifact is self-sufficient.
 *
 * Packs the package exactly as `npm publish` would, extracts the tarball into a
 * temp directory, then checks the three things that only fail after release:
 * the `files` list ships everything the runtime needs, the client artifact keeps
 * the loader's classic-script shape with the package name as its id, and the
 * Host half still registers its surface when imported from the extracted files.
 *
 * Run: npm run verify:pack
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'dsh-sidebar-browser-control-pack-'));

/**
 * Locate npm's CLI entry so it can be run with the current Node.
 *
 * Spawning `npm.cmd` directly is refused on Windows by Node 20+ (EINVAL, the
 * `.cmd` hardening), and `shell: true` would mangle paths containing spaces.
 * @returns absolute path to npm-cli.js.
 */
function npmCliPath() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate npm-cli.js next to ${process.execPath}; run "npm run test" instead`);
}

/**
 * Run one child process and return its trimmed stdout.
 * @param command - executable.
 * @param args - arguments.
 * @returns stdout text.
 */
function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Run the npm CLI with the current Node. @param args - npm arguments. @returns stdout text. */
function npm(args) {
  return run(process.execPath, [npmCliPath(), ...args]);
}

try {
  const packed = npm(['pack', '--pack-destination', work]).split(/\r?\n/u).pop();
  const tarball = join(work, packed ?? '');
  assert.ok(packed !== undefined && existsSync(tarball), `npm pack produced no readable tarball (${String(packed)})`);

  const extract = join(work, 'extract');
  mkdirSync(extract, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', extract]);
  const pkg = join(extract, 'package');

  const required = [
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'icon.svg',
    'locale/zh.json',
    'locale/en.json',
    'README.md',
    'LICENSE'
  ];
  for (const entry of required) {
    assert.ok(existsSync(join(pkg, entry)), `the published package is missing ${entry} (check the "files" list)`);
  }

  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  assert.notEqual(manifest.private, true, 'a publishable package must not set "private": true');
  assert.equal(manifest.name, 'dsh-sidebar-browser-control', 'unexpected package name');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'bundle patch must ship');
  assert.equal(manifest.dsh?.client?.platform, 'web', 'client half must declare the web platform');
  assert.equal(manifest.dsh?.client?.immediately, true, 'client half must load with the page');

  const client = readFileSync(join(pkg, 'client.js'), 'utf8');
  assert.match(client, /window\.__ModuleLoader__\.load\(/u, 'client artifact must use the module loader');
  assert.ok(client.includes(`id: '${manifest.name}'`), 'client bundle id must equal the package name');
  assert.ok(!/^\s*import[\s{]/mu.test(client), 'client artifact must not use ESM imports');

  const routes = [];
  const tools = new Map();
  const commands = new Map();
  const services = new Map([
    ['webServer', { register: (route) => { routes.push(route); return () => {}; } }],
    ['tools', { register: (definition) => { tools.set(definition.name, definition); return () => {}; } }],
    ['commands', { register: (definition) => { commands.set(definition.name, definition); return () => {}; } }]
  ]);
  const ctx = {
    get: (name) => services.get(name),
    effect: (callback) => {
      callback();
      return () => {};
    },
    inject: (_names, callback) => {
      callback(ctx);
      return () => {};
    },
    webServer: services.get('webServer'),
    tools: services.get('tools'),
    commands: services.get('commands')
  };

  const plugin = await import(pathToFileURL(join(pkg, 'index.js')).href);
  assert.deepEqual(plugin.inject, ['tools', 'webServer'], 'the Host half must declare its services');
  plugin.apply(ctx);
  assert.equal(routes.length, 4, `expected four routes, got ${routes.map((route) => route.path).join(', ')}`);
  assert.deepEqual([...tools.keys()].sort(), ['browser_control', 'browser_page', 'browser_tabs'], 'tool surface changed');
  assert.deepEqual([...commands.keys()], ['browser'], 'command surface changed');

  const shipped = run('tar', ['-tzf', tarball]).split(/\r?\n/u).filter((line) => line.length > 0);
  console.log(`verify-pack: OK — ${packed} ships ${shipped.length} entries, registers ${routes.length} routes, ${tools.size} tools and ${commands.size} command`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
