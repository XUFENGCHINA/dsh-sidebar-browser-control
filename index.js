/**
 * dsh-sidebar-browser-control — Host half.
 *
 * Gives the agent (and a `/browser` slash command) control over DSH's own
 * built-in browser: the right-hand Sidebar's Browser tab
 * (`@deepseek-ai/dsh-client-ui-sidebar-browser`).
 *
 * Architecture: the browser lives in the Web renderer, so the Host half owns
 * the *operations* and the Client half (client.js) owns the *presentation*.
 * They meet on four loopback routes served by `ctx.webServer`:
 *
 *   POST /sidebar-browser-control/hello   client announces itself
 *   GET  /sidebar-browser-control/poll    long-poll: Host -> Client commands
 *   POST /sidebar-browser-control/result  client settles one command
 *   GET  /sidebar-browser-control/status  diagnostics
 *
 * A tool call enqueues a command for the most recently active client, the held
 * long-poll delivers it immediately, and the call resolves when the client
 * settles it — so one operation has exactly one implementation and two callers
 * (tools and the slash command), while neither direction polls on a timer.
 *
 * Only the standard library is imported: a profile-installed bundle resolves
 * outside the DSH installation, so shipped packages are not on its import path.
 */

/** Route prefix owned by this plugin. */
const BASE = '/sidebar-browser-control';
/** How long one long-poll is held open before answering with no commands. */
const POLL_HOLD_MS = 10_000;
/** How long a command waits for the client to settle it. */
const CALL_TIMEOUT_MS = 30_000;
/** Largest request body accepted on the control routes. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** A client that has not spoken for this long stops receiving commands. */
const CLIENT_IDLE_MS = 120_000;
/** Requests may only come from the DSH application origin. */
const APPLICATION_ORIGIN = /^(dsh-app:\/\/app|https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?)$/iu;

/** Loader entry name for this plugin. */
export const name = 'sidebar-browser-control';
/** Hard dependencies: the tool registry and the HTTP carrier. */
export const inject = ['tools', 'webServer'];

/**
 * Answer one request with JSON.
 * @param res - node response owning the socket.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Read and parse a JSON request body.
 * @param req - node request.
 * @returns the parsed body, or an empty object for an empty body.
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Admit one request by its browser-supplied origin signals, so a random page in
 * the user's browser cannot drive the application's own browser panel.
 * @param req - node request.
 * @returns whether the request may proceed.
 */
function admitted(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && !APPLICATION_ORIGIN.test(origin)) return false;
  return true;
}

/** One connected browser client and its pending long-poll. */
class Client {
  /** @param id - opaque per-page identity. */
  constructor(id) {
    this.id = id;
    this.platform = 'unknown';
    this.capabilities = [];
    this.href = undefined;
    this.seenAt = Date.now();
    this.focused = false;
    this.queue = [];
    this.waiter = undefined;
  }
}

/** Host-side command router: the single implementation behind every caller. */
class Pilot {
  constructor() {
    /** @type {Map<string, Client>} */
    this.clients = new Map();
    /** @type {Map<string, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    this.sequence = 0;
  }

  /**
   * @param prefix - identifier prefix.
   * @returns a fresh opaque identifier.
   */
  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}${this.sequence}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Forget clients that stopped talking. */
  prune() {
    const cutoff = Date.now() - CLIENT_IDLE_MS;
    for (const [id, client] of this.clients) {
      if (client.seenAt < cutoff && client.waiter === undefined) this.clients.delete(id);
    }
  }

  /**
   * Register or refresh one client page.
   * @param input - client announcement.
   * @returns the client record.
   */
  hello(input) {
    this.prune();
    const claimed = typeof input.clientId === 'string' ? input.clientId : undefined;
    const client = claimed !== undefined && this.clients.has(claimed) ? this.clients.get(claimed) : new Client(this.nextId('client-'));
    client.platform = typeof input.platform === 'string' ? input.platform.slice(0, 32) : client.platform;
    client.capabilities = Array.isArray(input.capabilities) ? input.capabilities.filter((entry) => typeof entry === 'string').slice(0, 32) : [];
    client.href = typeof input.href === 'string' ? input.href.slice(0, 400) : undefined;
    client.seenAt = Date.now();
    this.clients.set(client.id, client);
    return client;
  }

  /** @returns the client that most deserves the next command: focused first, then most recent. */
  active() {
    this.prune();
    let best;
    for (const client of this.clients.values()) {
      if (best === undefined) {
        best = client;
        continue;
      }
      if (client.focused !== best.focused) {
        if (client.focused === true) best = client;
        continue;
      }
      if (client.seenAt > best.seenAt) best = client;
    }
    return best;
  }

  /**
   * Hold one long-poll open for a client until a command arrives.
   * @param clientId - announcing client.
   * @param res - node response to keep open.
   * @param focused - whether the page reported window focus.
   * @returns whether the client is known.
   */
  hold(clientId, res, focused) {
    const client = this.clients.get(clientId);
    if (client === undefined) return false;
    client.seenAt = Date.now();
    client.focused = focused === true;
    const waiter = { res, timer: undefined, closed: false, finish: undefined };
    waiter.finish = (value) => {
      if (waiter.closed) return;
      waiter.closed = true;
      if (client.waiter === waiter) client.waiter = undefined;
      clearTimeout(waiter.timer);
      sendJson(res, 200, value);
    };
    res.on('close', () => {
      if (waiter.closed) return;
      waiter.closed = true;
      clearTimeout(waiter.timer);
      if (client.waiter === waiter) client.waiter = undefined;
    });
    waiter.timer = setTimeout(() => waiter.finish({ ok: true, commands: [] }), POLL_HOLD_MS);
    client.waiter = waiter;
    this.flush(client);
    return true;
  }

  /**
   * Deliver queued commands to a held poll, if both exist.
   * @param client - the client to flush.
   */
  flush(client) {
    const waiter = client.waiter;
    if (waiter === undefined || client.queue.length === 0) return;
    const commands = client.queue.splice(0, client.queue.length);
    waiter.finish({ ok: true, commands });
  }

  /**
   * Run one operation in the connected browser page.
   * @param op - client operation name.
   * @param args - operation arguments.
   * @param signal - caller cancellation.
   * @returns the operation result.
   */
  async call(op, args, signal) {
    const client = this.active();
    if (client === undefined) {
      throw new Error('DSH 内置浏览器的控制端未连接：请打开 DSH 的 GUI 页面（插件的客户端半随页面加载），然后重试。');
    }
    const id = this.nextId('cmd-');
    client.queue.push({ id, op, args: args ?? {} });
    this.flush(client);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle();
        reject(new Error(`内置浏览器在 ${Math.round(CALL_TIMEOUT_MS / 1000)} 秒内没有响应；GUI 可能已关闭、正在刷新，或被模态框阻塞。`));
      }, CALL_TIMEOUT_MS);
      const abort = () => {
        settle();
        reject(new Error('内置浏览器操作已取消。'));
      };
      const settle = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', abort);
      };
      if (signal !== undefined) {
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
      }
      this.pending.set(id, {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        }
      });
    });
  }

  /**
   * Settle one command from a client.
   * @param input - client report.
   * @returns whether a pending call was waiting for it.
   */
  settle(input) {
    const id = typeof input.id === 'string' ? input.id : undefined;
    if (id === undefined) return false;
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    if (input.ok === true) entry.resolve(input.value ?? null);
    else entry.reject(new Error(typeof input.error === 'string' && input.error.length > 0 ? input.error : '内置浏览器操作失败。'));
    return true;
  }

  /** @returns a JSON snapshot for diagnostics. */
  status() {
    this.prune();
    return {
      clients: [...this.clients.values()].map((client) => ({
        id: client.id,
        platform: client.platform,
        capabilities: client.capabilities,
        href: client.href,
        held: client.waiter !== undefined,
        queued: client.queue.length,
        idleMs: Date.now() - client.seenAt
      })),
      pendingCalls: this.pending.size
    };
  }
}

/** Render the tab list as tool text. */
function tabsText(value) {
  const tabs = Array.isArray(value?.tabs) ? value.tabs : [];
  const header = `platform=${value?.platform ?? 'unknown'} page_control=${value?.page_control === true ? 'yes' : 'no'} panel_open=${value?.panel_open === true ? 'yes' : 'no'}`;
  if (tabs.length === 0) return `${header}\n内置浏览器当前没有打开任何标签页。`;
  const lines = tabs.map((tab) => {
    const marks = [tab.active === true ? 'active' : '', tab.on_screen === true ? 'on-screen' : 'other-session'].filter((mark) => mark.length > 0).join(',');
    const address = typeof tab.url === 'string' && tab.url.length > 0 ? ` — ${tab.url}` : '';
    return `- ${tab.tab_id}${marks.length > 0 ? ` [${marks}]` : ''} ${tab.title ?? ''}${address}`;
  });
  return `${header}\n${tabs.length} 个内置浏览器标签页：\n${lines.join('\n')}`;
}

/** Render one control/page result as tool text. */
function actionText(value) {
  if (value === null || typeof value !== 'object') return String(value ?? '完成');
  const parts = [];
  if (typeof value.action === 'string') parts.push(value.action);
  if (typeof value.tab_id === 'string') parts.push(`tab=${value.tab_id}`);
  if (typeof value.url === 'string' && value.url.length > 0) parts.push(value.url);
  if (typeof value.title === 'string' && value.title.length > 0) parts.push(`title=${value.title}`);
  const head = parts.length > 0 ? parts.join(' ') : '完成';
  const body = [];
  if (typeof value.text === 'string' && value.text.length > 0) body.push(value.text);
  if (typeof value.note === 'string' && value.note.length > 0) body.push(`注意：${value.note}`);
  if (value.value !== undefined && value.value !== null) body.push(JSON.stringify(value.value));
  if (Array.isArray(value.links) && value.links.length > 0) {
    body.push(value.links.map((link) => `- ${link.text ?? ''} ${link.href ?? ''}`).join('\n'));
  }
  if (Array.isArray(value.elements) && value.elements.length > 0) {
    body.push(value.elements.map((element) => `- ${element.selector ?? ''} ${element.text ?? ''}`).join('\n'));
  }
  return body.length === 0 ? head : `${head}\n${body.join('\n')}`;
}

/**
 * Register the browser control surface.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const pilot = new Pilot();

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/hello`,
    handler: async (req, res) => {
      if (!admitted(req)) {
        sendJson(res, 403, { ok: false, error: 'origin not allowed' });
        return;
      }
      try {
        const body = await readJson(req);
        const client = pilot.hello(body);
        sendJson(res, 200, { ok: true, clientId: client.id, holdMs: POLL_HOLD_MS });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    }
  }), 'sidebar-browser-control.hello');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/poll`,
    handler: (req, res) => {
      if (!admitted(req)) {
        sendJson(res, 403, { ok: false, error: 'origin not allowed' });
        return;
      }
      const clientId = new URL(req.url ?? '/', 'http://x').searchParams.get('clientId');
      const focused = new URL(req.url ?? '/', 'http://x').searchParams.get('focus') === '1';
      if (clientId === null || !pilot.hold(clientId, res, focused)) sendJson(res, 410, { ok: false, error: 'unknown-client' });
    }
  }), 'sidebar-browser-control.poll');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/result`,
    handler: async (req, res) => {
      if (!admitted(req)) {
        sendJson(res, 403, { ok: false, error: 'origin not allowed' });
        return;
      }
      try {
        const body = await readJson(req);
        if (typeof body.clientId === 'string') {
          const client = pilot.clients.get(body.clientId);
          if (client !== undefined) client.seenAt = Date.now();
        }
        sendJson(res, 200, { ok: true, settled: pilot.settle(body) });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    }
  }), 'sidebar-browser-control.result');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/status`,
    handler: (req, res) => {
      if (!admitted(req)) {
        sendJson(res, 403, { ok: false, error: 'origin not allowed' });
        return;
      }
      sendJson(res, 200, { ok: true, ...pilot.status() });
    }
  }), 'sidebar-browser-control.status');

  const sharedOutput = {
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        tab_id: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        text: { type: 'string' },
        note: { type: 'string' },
        platform: { type: 'string' },
        page_control: { type: 'boolean' }
      }
    }
  };

  ctx.effect(() => ctx.tools.register({
    name: 'browser_tabs',
    description: "List the tabs open in DSH's own built-in browser (the right-hand Sidebar's Browser panel), with each tab's id, title, URL and owning session. Also reports whether page-level control (read/click/type/eval) is available — it is on the Desktop app, not in a plain browser tab. Call this first when you need a tab id for browser_control or browser_page.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { ...sharedOutput, render: (_args, value) => [{ type: 'text', text: tabsText(value) }] },
    async execute(_args, exec) {
      return await pilot.call('tabs', {}, exec.signal);
    }
  }), 'sidebar-browser-control.tool.tabs');

  ctx.effect(() => ctx.tools.register({
    name: 'browser_control',
    description: "Drive DSH's own built-in browser: open a URL in the right-hand Sidebar Browser, navigate an existing tab, go back/forward, reload, close or focus a tab, control the panel (expand/collapse/fullscreen/split/float/dock), or hand the current page to the system browser. Actions apply to the session currently on screen. Use browser_tabs to obtain a tab id; omitting tab_id acts on the active tab.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'navigate', 'back', 'forward', 'reload', 'close', 'focus', 'expand', 'collapse', 'fullscreen', 'split', 'float', 'dock', 'external'],
          description: 'open: load a URL (a new tab unless tab_id is given, in which case that tab is replaced). navigate: load a URL in the given tab. back/forward/reload: drive the page. close/focus: tab lifecycle. expand/collapse/fullscreen: the Sidebar panel. split/float/dock: pane layout. external: open the current page in the system browser.'
        },
        url: { type: 'string', description: 'HTTP(S) address for open/navigate. A bare host is completed with https://' },
        tab_id: { type: 'string', description: 'Target tab id from browser_tabs; omit for the active tab.' }
      },
      required: ['action']
    },
    output: { ...sharedOutput, render: (_args, value) => [{ type: 'text', text: actionText(value) }] },
    async execute(args, exec) {
      return await pilot.call('control', args, exec.signal);
    }
  }), 'sidebar-browser-control.tool.control');

  ctx.effect(() => ctx.tools.register({
    name: 'browser_page',
    description: "Read and act on the page inside DSH's built-in browser tab (Desktop app only; browser_tabs reports page_control). text returns the page's visible text, links lists anchors, elements lists interactive elements with a usable selector for click, eval runs JavaScript in the page and returns its JSON value, click clicks a selector or the element containing text, type fills a field (optionally submitting), scroll scrolls, wait waits for a selector or text.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['text', 'links', 'elements', 'eval', 'click', 'type', 'scroll', 'wait'],
          description: 'What to do with the page.'
        },
        tab_id: { type: 'string', description: 'Target tab id from browser_tabs; omit for the active tab.' },
        selector: { type: 'string', description: 'CSS selector for click/type/scroll/wait.' },
        text: { type: 'string', description: 'Text to type, or text to match for click/wait when no selector is given.' },
        code: { type: 'string', description: 'JavaScript for eval. Use an expression, or statements ending in a return.' },
        submit: { type: 'boolean', description: 'type: submit the form afterwards.' },
        ms: { type: 'number', description: 'wait: timeout in milliseconds (default 10000). scroll: pixels to scroll (default one viewport).' },
        max_chars: { type: 'number', description: 'text/links: truncate the returned text (default 8000 characters).' }
      },
      required: ['action']
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          tab_id: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          note: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: actionText(value) }]
    },
    async execute(args, exec) {
      return await pilot.call('page', args, exec.signal);
    }
  }), 'sidebar-browser-control.tool.page');

  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'browser',
      description: '驱动 DSH 内置浏览器：/browser open <url> | tabs | back | forward | reload | close | expand | collapse | fullscreen | split | read',
      input: { hint: 'open <url> | tabs | back | forward | reload | close | expand | collapse | fullscreen | split | read' },
      async handler(invocation) {
        try {
          return { kind: 'success', text: await runCommand(pilot, invocation) };
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) };
        }
      }
    }), 'sidebar-browser-control.command');
  });
}

/**
 * Run one `/browser` line against the same operations the tools use.
 * @param pilot - command router.
 * @param invocation - command invocation.
 * @returns human-readable report text.
 */
async function runCommand(pilot, invocation) {
  const [word, ...rest] = invocation.rawInput.trim().split(/\s+/u);
  const verb = (word ?? '').toLowerCase() === '' ? 'tabs' : word.toLowerCase();
  const argument = rest.join(' ').trim();
  const signal = invocation.signal;
  switch (verb) {
    case 'tabs':
    case 'list':
      return tabsText(await pilot.call('tabs', {}, signal));
    case 'open':
    case 'go': {
      if (argument.length === 0) throw new Error('用法：/browser open <url>');
      return actionText(await pilot.call('control', { action: 'open', url: argument }, signal));
    }
    case 'read':
      return actionText(await pilot.call('page', { action: 'text', ...argument.length > 0 ? { tab_id: argument } : {} }, signal));
    case 'back':
    case 'forward':
    case 'reload':
    case 'close':
    case 'focus':
    case 'expand':
    case 'collapse':
    case 'fullscreen':
    case 'split':
    case 'float':
    case 'dock':
    case 'external':
    case 'navigate':
      return actionText(await pilot.call('control', { action: verb, ...argument.length > 0 ? { tab_id: argument } : {} }, signal));
    default:
      throw new Error(`未知的 /browser 子命令：${verb}（可用：open、tabs、back、forward、reload、close、focus、expand、collapse、fullscreen、split、float、dock、external、read）`);
  }
}
