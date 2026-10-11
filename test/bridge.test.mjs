/**
 * Offline bridge test for dsh-sidebar-browser-control.
 *
 * Loads the Host half against a stub Cordis context, serves its routes from a
 * real node:http server, and plays one fake Client half: handshake, long-poll,
 * command execution, result reporting. Verifies the operation surface without
 * touching a running DSH profile.
 *
 * Run: node test/bridge.test.mjs
 */

import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const plugin = await import('../index.js');

/** Routes registered by the plugin, in registration order. */
const routes = [];
/** Tools registered by the plugin. */
const tools = new Map();
/** Commands registered by the plugin. */
const commands = new Map();

const webServer = {
  register(route) {
    routes.push(route);
    return () => {
      const index = routes.indexOf(route);
      if (index >= 0) routes.splice(index, 1);
    };
  }
};

const toolsService = {
  register(definition) {
    tools.set(definition.name, definition);
    return () => tools.delete(definition.name);
  }
};

const commandsService = {
  register(definition) {
    commands.set(definition.name, definition);
    return () => commands.delete(definition.name);
  }
};

const services = new Map([
  ['webServer', webServer],
  ['tools', toolsService],
  ['commands', commandsService]
]);

const disposers = [];
const ctx = {
  get: (name) => services.get(name),
  effect: (callback) => {
    const disposer = callback();
    disposers.push(disposer);
    return () => disposer?.();
  },
  inject: (names, callback) => {
    callback(ctx);
    return () => {};
  },
  webServer,
  tools: toolsService,
  commands: commandsService
};

plugin.apply(ctx);

assert.deepEqual(typeof plugin.name, 'string', 'plugin exports a name');
assert.deepEqual(plugin.inject, ['tools', 'webServer'], 'plugin declares its services');
assert.equal(routes.length, 4, `registers four routes, got ${routes.map((route) => route.path).join(', ')}`);
assert.deepEqual([...tools.keys()].sort(), ['browser_control', 'browser_page', 'browser_tabs'], 'registers three tools');
assert.deepEqual([...commands.keys()], ['browser'], 'registers the /browser command');

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const route = routes.find((candidate) => candidate.kind === 'exact' && candidate.path === path);
  if (route === undefined) {
    res.writeHead(404).end('no route');
    return;
  }
  void route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

/** Commands one fake client should answer, keyed by operation. */
const scripted = {
  tabs: () => ({
    platform: 'desktop',
    page_control: true,
    panel_open: true,
    active_tab: 'tab7',
    tabs: [{ tab_id: 'tab7', title: '示例页', url: 'https://example.com/', session: 'session-1', on_screen: true, active: true }]
  }),
  control: (args) => ({ action: args.action, tab_id: args.tab_id ?? 'tab7', url: args.url ?? 'https://example.com/' }),
  page: (args) => (args.action === 'eval' ? { action: 'eval', tab_id: 'tab7', value: { answer: 42 } } : { action: args.action, tab_id: 'tab7', text: '页面正文' })
};

/** One fake Client half: handshake, long-poll, execute, report. */
async function runFakeClient() {
  const hello = await fetch(`${origin}/sidebar-browser-control/hello`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'desktop', capabilities: ['tabs', 'control', 'page'], href: 'dsh-app://app/' })
  }).then((response) => response.json());
  assert.equal(hello.ok, true, 'handshake succeeds');
  const clientId = hello.clientId;

  for (let round = 0; round < 8; round += 1) {
    const answer = await fetch(`${origin}/sidebar-browser-control/poll?clientId=${encodeURIComponent(clientId)}&focus=1`).then((response) => response.json());
    for (const command of answer.commands ?? []) {
      const handler = scripted[command.op];
      const value = handler === undefined ? undefined : handler(command.args ?? {});
      await fetch(`${origin}/sidebar-browser-control/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, id: command.id, ok: handler !== undefined, value, error: handler === undefined ? `unsupported ${command.op}` : undefined })
      });
    }
  }
}

const clientLoop = runFakeClient();
await new Promise((resolve) => setTimeout(resolve, 100));

const exec = { signal: new AbortController().signal, callId: 'call-1' };

const tabsValue = await tools.get('browser_tabs').execute({}, exec);
assert.equal(tabsValue.tabs.length, 1, 'browser_tabs returns the client tab list');
const tabsText = tools.get('browser_tabs').output.render({}, tabsValue);
assert.match(tabsText[0].text, /tab7/u, 'tabs render names the tab');

const controlValue = await tools.get('browser_control').execute({ action: 'open', url: 'https://example.com/' }, exec);
assert.equal(controlValue.action, 'open', 'browser_control forwards the action');

const pageValue = await tools.get('browser_page').execute({ action: 'eval', code: '1+1' }, exec);
assert.deepEqual(pageValue.value, { answer: 42 }, 'browser_page returns the page value');

const commandResult = await commands.get('browser').handler({
  rawInput: 'tabs',
  agent: { id: 'session-1' },
  signal: exec.signal,
  attachments: [],
  commandId: 'command-1'
});
assert.equal(commandResult.kind, 'success', '/browser tabs succeeds');
assert.match(commandResult.text, /tab7/u, '/browser tabs reports the tab');

const status = await fetch(`${origin}/sidebar-browser-control/status`).then((response) => response.json());
assert.equal(status.clients.length, 1, 'status reports the connected client');
assert.equal(status.clients[0].platform, 'desktop', 'status reports the platform');

const refused = await fetch(`${origin}/sidebar-browser-control/hello`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: JSON.stringify({})
});
assert.equal(refused.status, 403, 'a foreign origin is refused');

server.close();
clientLoop.catch(() => {});
for (const disposer of disposers) await disposer?.();

console.log('bridge test: OK');
process.exit(0);
