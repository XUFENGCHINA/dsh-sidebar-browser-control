/**
 * dsh-sidebar-browser-control — Client half.
 *
 * Runs in the DSH Web page (Desktop app or browser tab) and owns everything the
 * Host cannot reach: `ctx.sidebarRight` (the right-hand Sidebar's navigation
 * controller) and, on Desktop, the live `<webview>` of each Browser tab.
 *
 * It holds one long-poll open to the Host half, executes the commands that
 * arrive through it, and reports each result back. Nothing here runs on a timer.
 *
 * Tab identity: a Sidebar layout tab id is unique per Session only, so every
 * tab this plugin reports carries the Session that owns it. A `tab_id` that is
 * ambiguous across Sessions is reported and accepted as `<sessionId>#<tabId>`,
 * and every lookup is scoped by Session when one is known.
 *
 * Carrier note: the Browser tab is an Electron `<webview>` on Desktop and a
 * sandboxed `<iframe>` in the browser. Layout, tab lifecycle and navigation are
 * available on both; reading the page, evaluating JavaScript, clicking and
 * typing need the webview, so they report an explicit limitation in a browser
 * tab instead of failing silently.
 *
 * Deliberately absent: screenshots. `webview.capturePage()` crashed the Electron
 * renderer on this deployment (2026-10-11, app 0.2.0-rc.2 / Electron 44), so the
 * capability is not offered at all rather than shipped as a landmine.
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-browser-control',
  factory: () => {
    /** Route prefix owned by the Host half. */
    const BASE = '/sidebar-browser-control';
    /** Retry delay after a transport failure. */
    const RETRY_MS = 1500;

    /** Bridge state, owned by one page. */
    const state = {
      clientId: undefined,
      stopped: true,
      refusals: 0
    };

    /** Plugin context, captured on apply. */
    let context;

    /** @param ms - milliseconds to wait. @returns a promise resolving afterwards. */
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** @returns whether this page is the Desktop application. */
    function isDesktop() {
      const carrier = globalThis.dshDesktop;
      return carrier !== undefined && carrier !== null && carrier.protocolVersion === 1;
    }

    /** @returns the platform token reported to the Host. */
    function platformName() {
      return isDesktop() ? 'desktop' : 'web';
    }

    /** @returns the capability list reported to the Host. */
    function capabilities() {
      return isDesktop() ? ['tabs', 'control', 'page'] : ['tabs', 'control'];
    }

    /** @returns the sidebar navigation controller. */
    function sidebar() {
      const service = context?.get('sidebarRight');
      if (service === undefined || service === null) {
        throw new Error('DSH 的右侧栏服务（sidebarRight）当前不可用，因此无法控制内置浏览器。');
      }
      return service;
    }

    /** @param text - candidate text. @param limit - maximum length. @returns truncated text. */
    function clamp(text, limit) {
      if (text.length <= limit) return text;
      return `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）`;
    }

    /** @returns every Browser tab DSH knows about, across Sessions. */
    function browserEntries() {
      const entries = (sidebar().openTabs?.getSnapshot?.() ?? []).filter((entry) => entry.kind === 'browser');
      const counts = new Map();
      for (const entry of entries) counts.set(entry.tabId, (counts.get(entry.tabId) ?? 0) + 1);
      return entries.map((entry) => ({
        ...entry,
        handle: counts.get(entry.tabId) > 1 ? `${entry.sessionId}#${entry.tabId}` : entry.tabId
      }));
    }

    /**
     * Split a tab handle into its Session and layout id.
     * @param handle - `tab7`, or `sessionId#tab7` for an ambiguous id.
     * @returns `{ tabId, sessionId }`.
     */
    function parseHandle(handle) {
      const text = String(handle ?? '').trim();
      if (text.length === 0) throw new Error('标签页标识不能为空。');
      const separator = text.indexOf('#');
      if (separator < 0) return { tabId: text, sessionId: undefined };
      return { tabId: text.slice(separator + 1), sessionId: text.slice(0, separator) };
    }

    /** @returns the on-screen Session id, when a Session is on screen. */
    function onScreenSession() {
      try {
        return sidebar().mounted?.getSnapshot?.();
      } catch {
        return undefined;
      }
    }

    /**
     * Resolve one tab handle to the entry that owns it.
     * @param handle - tab id or `sessionId#tabId`.
     * @returns the matching inventory entry.
     */
    function findEntry(handle) {
      const { tabId, sessionId } = parseHandle(handle);
      const entries = browserEntries();
      const scoped = sessionId === undefined ? entries : entries.filter((entry) => entry.sessionId === sessionId);
      const exact = scoped.filter((entry) => entry.tabId === tabId);
      if (exact.length === 1) return exact[0];
      if (exact.length === 0) {
        throw new Error(sessionId === undefined
          ? `找不到内置浏览器标签页 ${tabId}；可用 browser_tabs 查看当前打开的内置浏览器标签页。`
          : `会话 ${sessionId} 里没有内置浏览器标签页 ${tabId}。`);
      }
      const screen = onScreenSession();
      const preferred = exact.find((entry) => entry.sessionId === screen);
      if (preferred !== undefined) return preferred;
      throw new Error(`标签页 ${tabId} 在多个会话里都存在；请改用带会话前缀的标识：${exact.map((entry) => entry.handle).join(' 或 ')}`);
    }

    /**
     * The tab a command without `tab_id` acts on: the active tab when it is a
     * Browser tab, otherwise the newest Browser tab of the on-screen Session.
     * @returns an inventory entry, or undefined when no Browser tab is open.
     */
    function defaultEntry() {
      const entries = browserEntries();
      if (entries.length === 0) return undefined;
      const screen = onScreenSession();
      const active = activeTabEntry();
      if (active !== undefined && entries.some((entry) => entry.handle === active.handle)) return entries.find((entry) => entry.handle === active.handle);
      const sameSession = entries.filter((entry) => entry.sessionId === screen);
      const pool = sameSession.length > 0 ? sameSession : entries;
      return pool[pool.length - 1];
    }

    /** @returns the active tab of the active pane as an inventory entry, if it is a Browser tab. */
    function activeTabEntry() {
      try {
        const record = sidebar().active?.();
        if (record === undefined || record.kind !== 'browser') return undefined;
        const screen = onScreenSession();
        if (screen === undefined) return undefined;
        return browserEntries().find((entry) => entry.sessionId === screen && entry.tabId === record.id);
      } catch {
        return undefined;
      }
    }

    /**
     * Find one Session's Sidebar subtree in the document.
     * @param sessionId - owning Session.
     * @returns the subtree root, or undefined when it is not rendered.
     */
    function sessionScope(sessionId) {
      if (sessionId === undefined) return undefined;
      for (const node of document.querySelectorAll('[data-sidebar-right-session]')) {
        if (node.dataset.sidebarRightSession === sessionId) return node;
      }
      return undefined;
    }

    /**
     * Find a tab's marker element, scoped by Session when it is known.
     * @param tabId - layout tab id.
     * @param sessionId - owning Session.
     * @returns the marker, if rendered.
     */
    function tabMarker(tabId, sessionId) {
      const scopes = sessionScope(sessionId) === undefined ? [document] : [sessionScope(sessionId)];
      for (const scope of scopes) {
        for (const node of scope.querySelectorAll('[data-sidebar-right-tab]')) {
          if (node.dataset.sidebarRightTab === tabId) return node;
        }
      }
      return undefined;
    }

    /**
     * Find a tab's rendered page carrier.
     * @param tabId - layout tab id.
     * @param sessionId - owning Session.
     * @returns the webview or iframe element, if mounted.
     */
    function frameFor(tabId, sessionId) {
      const scopes = sessionScope(sessionId) === undefined ? [document] : [sessionScope(sessionId)];
      for (const scope of scopes) {
        for (const frame of scope.querySelectorAll('webview[data-sidebar-browser-frame], iframe[data-sidebar-browser-frame]')) {
          const marker = frame.closest('[data-sidebar-right-tab]');
          if (marker !== null && marker.dataset.sidebarRightTab === tabId) return frame;
        }
      }
      return undefined;
    }

    /** @param frame - a carrier element. @returns whether it is the Electron webview. */
    function isWebview(frame) {
      return frame.tagName !== undefined && frame.tagName.toLowerCase() === 'webview';
    }

    /** @param frame - a carrier element. @returns its current address, when readable. */
    function frameUrl(frame) {
      if (frame === undefined) return undefined;
      try {
        if (isWebview(frame)) {
          const url = frame.getURL();
          return typeof url === 'string' && url.length > 0 && url !== 'about:blank' ? url : undefined;
        }
        const src = frame.getAttribute('src');
        return src === null || src.startsWith('about:blank') ? undefined : new URL(src, location.href).href;
      } catch {
        return undefined;
      }
    }

    /** @param frame - a carrier element. @returns its document title, when readable. */
    function frameTitle(frame) {
      if (frame === undefined) return '';
      try {
        return isWebview(frame) ? String(frame.getTitle() ?? '') : '';
      } catch {
        return '';
      }
    }

    /** @param entry - inventory entry. @returns the committed tab record. */
    function recordFor(entry) {
      try {
        const service = sidebar();
        if (typeof service.tabsIn !== 'function') return undefined;
        return service.tabsIn(entry.sessionId).find((record) => record.id === entry.tabId);
      } catch {
        return undefined;
      }
    }

    /** @param entry - inventory entry. @returns the pane id holding the tab, when rendered. */
    function paneFor(entry) {
      const marker = tabMarker(entry.tabId, entry.sessionId);
      const pane = marker?.closest('[data-dockkit-pane], [data-dockkit-float]');
      return pane?.getAttribute('data-dockkit-pane') ?? pane?.getAttribute('data-dockkit-float') ?? undefined;
    }

    /** @returns every Browser tab, with the addresses its carrier can report. */
    function listTabs() {
      const service = sidebar();
      const screen = onScreenSession();
      const active = activeTabEntry();
      const tabs = browserEntries().map((entry) => {
        const frame = frameFor(entry.tabId, entry.sessionId);
        const record = recordFor(entry);
        return {
          tab_id: entry.handle,
          title: frameTitle(frame) || record?.title || '',
          url: frameUrl(frame),
          session: entry.sessionId,
          on_screen: entry.sessionId === screen,
          active: active !== undefined && active.handle === entry.handle,
          pane: paneFor(entry)
        };
      });
      return {
        platform: platformName(),
        page_control: isDesktop(),
        panel_open: service.isExpanded?.() === true,
        active_tab: active?.handle,
        tabs
      };
    }

    /**
     * Resolve the carrier and identity a command targets.
     * @param args - command arguments.
     * @returns `{ entry, frame, tabId, sessionId }`.
     */
    function resolveTarget(args) {
      const requested = typeof args?.tab_id === 'string' && args.tab_id.trim().length > 0 ? args.tab_id.trim() : undefined;
      const entry = requested === undefined ? defaultEntry() : findEntry(requested);
      if (entry === undefined) {
        throw new Error('内置浏览器当前没有标签页；请先用 browser_control 的 open 打开一个网址。');
      }
      const frame = frameFor(entry.tabId, entry.sessionId);
      if (frame === undefined) {
        throw new Error(`标签页 ${entry.handle} 当前没有已挂载的页面（它可能在别的会话、已收起，或还未渲染）。可先用 browser_control 的 focus 把它带到屏幕上。`);
      }
      return { entry, frame, tabId: entry.tabId, sessionId: entry.sessionId };
    }

    /**
     * Require the Desktop carrier for page-level operations.
     * @param frame - resolved carrier.
     * @returns the webview element.
     */
    function requireWebview(frame) {
      if (!isWebview(frame)) {
        throw new Error('页面级操作（读取、eval、点击、输入、截图）只在 Desktop 应用的内置浏览器里可用：浏览器版的 iframe 受 sandbox 与同源策略限制，无法读取页面内容。');
      }
      return frame;
    }

    /**
     * Complete a bare host name and validate an address exactly as the Browser's
     * own address bar does.
     * @param input - user or model supplied address.
     * @returns the normalized absolute URL.
     */
    function parseAddress(input) {
      const raw = String(input ?? '').trim();
      if (raw.length === 0) throw new Error('需要一个网址。');
      if (/\s/u.test(raw)) throw new Error(`网址不能包含空格：${raw}`);
      const candidate = /^[a-z][a-z0-9+.-]*:/iu.test(raw) ? raw : `https://${raw}`;
      let url;
      try {
        url = new URL(candidate);
      } catch {
        throw new Error(`无法识别的网址：${raw}`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('内置浏览器只支持 http/https 网址（本地文件请用文档预览）。');
      }
      if (url.username.length > 0 || url.password.length > 0) throw new Error('网址不能包含用户名或密码。');
      if (url.origin === location.origin) throw new Error('不能在嵌入式浏览器里打开 DSH 应用自身。');
      return url.href;
    }

    /**
     * Wait for a freshly opened Browser tab to appear in the inventory.
     * @param known - handles that existed before the open.
     * @param sessionId - the Session the tab was opened in.
     * @param timeoutMs - how long to wait.
     * @returns the new entry, or undefined when the layout never reported one.
     */
    async function waitForNewEntry(known, sessionId, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const fresh = browserEntries().find((entry) => !known.has(entry.handle) && (sessionId === undefined || entry.sessionId === sessionId));
        if (fresh !== undefined) return fresh;
        await sleep(50);
      }
      return undefined;
    }

    /**
     * Wait for a tab's carrier element to be mounted.
     * @param tabId - layout tab id.
     * @param sessionId - owning Session.
     * @param timeoutMs - how long to wait.
     * @returns the carrier, or undefined.
     */
    async function waitForFrame(tabId, sessionId, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const frame = frameFor(tabId, sessionId);
        if (frame !== undefined) return frame;
        await sleep(50);
      }
      return undefined;
    }

    /** @param value - page value. @param limit - maximum JSON length. @returns a JSON-safe value. */
    function clampValue(value, limit) {
      if (value === undefined) return null;
      let text;
      try {
        text = JSON.stringify(value);
      } catch {
        return String(value).slice(0, limit);
      }
      if (text === undefined) return String(value).slice(0, limit);
      if (text.length <= limit) return value;
      return `${text.slice(0, limit)}…（已截断，共 ${text.length} 字符）`;
    }

    /**
     * Build the in-page expression that resolves a click/wait target.
     * @param selector - optional CSS selector.
     * @param text - optional visible text.
     * @returns JavaScript source evaluating to an element or null.
     */
    function matchExpression(selector, text) {
      return `(() => {
        const selector = ${JSON.stringify(selector ?? null)};
        const wanted = ${JSON.stringify(text ?? null)};
        if (selector !== null && selector.length > 0) return document.querySelector(selector);
        if (wanted !== null && wanted.length > 0) {
          const nodes = [...document.querySelectorAll('a,button,input,textarea,select,summary,label,li,td,th,span,div,p,[role=button],[role=link],[tabindex]')];
          const read = (node) => (node.innerText || node.value || node.textContent || '').replace(/\\s+/g, ' ').trim();
          return nodes.find((node) => read(node) === wanted) ?? nodes.find((node) => read(node).includes(wanted)) ?? null;
        }
        return null;
      })()`;
    }

    /**
     * Wait for a navigation the carrier started to finish, so a reported URL is
     * the one the model will actually act on.
     * @param view - carrier element.
     * @param previousUrl - address observed before the command.
     * @param timeoutMs - how long to wait.
     * @returns the settled address.
     */
    async function settle(view, previousUrl, timeoutMs = 8000) {
      const started = Date.now();
      await sleep(150);
      const deadline = started + timeoutMs;
      while (Date.now() < deadline) {
        let loading = false;
        try {
          loading = view.isLoading() === true;
        } catch {
          loading = false;
        }
        const url = frameUrl(view);
        if (!loading && (url !== previousUrl || Date.now() - started > 700)) return url;
        await sleep(120);
      }
      return frameUrl(view);
    }

    /**
     * Run one `control` command through the sidebar controller and the carrier.
     * @param args - command arguments.
     * @returns the operation result.
     */
    async function control(args) {
      const service = sidebar();
      const action = String(args?.action ?? '').toLowerCase();
      const requested = typeof args?.tab_id === 'string' && args.tab_id.trim().length > 0 ? args.tab_id.trim() : undefined;
      const url = typeof args?.url === 'string' && args.url.length > 0 ? parseAddress(args.url) : undefined;

      switch (action) {
        case 'open': {
          if (url === undefined) throw new Error('open 需要一个 url 参数。');
          const target = requested === undefined ? undefined : findEntry(requested);
          const known = new Set(browserEntries().map((entry) => entry.handle));
          service.openTab('browser', {
            params: { url },
            ...target !== undefined ? { replaceTab: target.tabId } : {},
            revealIfOpened: false
          });
          const screen = onScreenSession();
          const entry = (await waitForNewEntry(known, screen)) ?? (target !== undefined ? target : defaultEntry());
          if (entry !== undefined) await waitForFrame(entry.tabId, entry.sessionId, 3000);
          const frame = entry === undefined ? undefined : frameFor(entry.tabId, entry.sessionId);
          return {
            action,
            tab_id: entry?.handle,
            session: entry?.sessionId,
            url,
            title: frameTitle(frame) || (entry === undefined ? undefined : recordFor(entry)?.title)
          };
        }
        case 'navigate': {
          if (url === undefined) throw new Error('navigate 需要一个 url 参数。');
          const target = requested === undefined ? defaultEntry() : findEntry(requested);
          if (target === undefined) return await control({ action: 'open', url: args.url });
          const frame = frameFor(target.tabId, target.sessionId);
          if (isWebview(frame)) {
            await frame.loadURL(url);
            return { action, tab_id: target.handle, url, title: frameTitle(frame) };
          }
          service.openTab('browser', { params: { url }, replaceTab: target.tabId, revealIfOpened: false });
          return { action, tab_id: target.handle, url };
        }
        case 'back':
        case 'forward':
        case 'reload': {
          const { frame, entry } = resolveTarget(args);
          const view = requireWebview(frame);
          const before = frameUrl(view);
          if (action === 'reload') view.reload();
          else if (action === 'back') view.goBack();
          else view.goForward();
          return { action, tab_id: entry.handle, url: await settle(view, before), title: frameTitle(view) };
        }
        case 'close': {
          const entry = requested === undefined ? defaultEntry() : findEntry(requested);
          if (entry === undefined) throw new Error('没有可关闭的标签页。');
          if (entry.sessionId !== onScreenSession()) {
            throw new Error(`标签页 ${entry.handle} 属于另一个会话；请先切换到该会话，或改用带会话前缀的标识在屏幕上打开它。`);
          }
          service.close(entry.tabId);
          return { action, tab_id: entry.handle };
        }
        case 'focus': {
          const entry = requested === undefined ? defaultEntry() : findEntry(requested);
          if (entry === undefined) throw new Error('没有可聚焦的标签页。');
          service.focus(entry.tabId);
          const frame = frameFor(entry.tabId, entry.sessionId);
          return { action, tab_id: entry.handle, title: frameTitle(frame) || recordFor(entry)?.title };
        }
        case 'expand': {
          const wasOpen = service.isExpanded() === true;
          if (!wasOpen) service.toggleExpanded();
          return { action, note: wasOpen ? '右侧栏本来就是展开的。' : undefined };
        }
        case 'collapse': {
          const wasOpen = service.isExpanded() === true;
          if (wasOpen) service.toggleExpanded();
          return { action, note: wasOpen ? undefined : '右侧栏本来就是收起的。' };
        }
        case 'fullscreen': {
          const target = service.commandTarget();
          if (target === undefined) throw new Error('当前没有可以切换全屏的停靠分栏（需要屏幕上有会话，且右侧栏已展开）。');
          service.toggleFullscreen(target);
          return { action, tab_id: target.tabId, note: '已切换右侧栏的显示模式。' };
        }
        case 'split': {
          const paneId = service.split();
          return { action, pane: paneId, note: paneId === undefined ? '当前没有可分割的停靠分栏（或已到两格上限）。' : undefined };
        }
        case 'float': {
          const entry = requested === undefined ? defaultEntry() : findEntry(requested);
          if (entry === undefined) throw new Error('没有可浮出的标签页。');
          service.float(entry.tabId);
          return { action, tab_id: entry.handle };
        }
        case 'dock': {
          const entry = requested === undefined ? defaultEntry() : findEntry(requested);
          if (entry === undefined) throw new Error('没有可停靠的标签页。');
          const marker = tabMarker(entry.tabId, entry.sessionId);
          const floatPane = marker?.closest('[data-dockkit-float]');
          const paneId = floatPane?.getAttribute('data-dockkit-float') ?? undefined;
          if (paneId === undefined) throw new Error('该标签页当前不在浮窗里。');
          service.dock(paneId);
          return { action, tab_id: entry.handle, pane: paneId };
        }
        case 'external': {
          const { frame, entry } = resolveTarget(args);
          const href = frameUrl(frame);
          if (href === undefined) throw new Error('读不到当前页面的网址，无法在系统浏览器中打开。');
          window.open(href, '_blank', 'noopener,noreferrer');
          return { action, tab_id: entry.handle, url: href };
        }
        default:
          throw new Error(`未知的 control 动作：${action}`);
      }
    }

    /**
     * Run one `page` command against the tab's webview.
     * @param args - command arguments.
     * @returns the operation result.
     */
    async function page(args) {
      const action = String(args?.action ?? '').toLowerCase();
      const { frame, entry } = resolveTarget(args);
      const view = requireWebview(frame);
      const limit = Number.isFinite(args?.max_chars) ? Math.max(200, Math.min(200_000, Math.trunc(args.max_chars))) : 8000;
      const base = { action, tab_id: entry.handle, url: frameUrl(view), title: frameTitle(view) };

      switch (action) {
        case 'text': {
          const text = await view.executeJavaScript('(() => { const body = document.body; return body === null ? "" : body.innerText; })()');
          return { ...base, text: clamp(typeof text === 'string' ? text : JSON.stringify(text), limit) };
        }
        case 'links': {
          const links = await view.executeJavaScript('(() => [...document.querySelectorAll("a[href]")].slice(0, 300).map((node) => ({ text: (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160), href: node.href })).filter((link) => link.href.startsWith("http")))()');
          const list = Array.isArray(links) ? links : [];
          return { ...base, links: list.slice(0, 120), text: clamp(list.map((link) => `- ${link.text} ${link.href}`).join('\n'), limit) };
        }
        case 'elements': {
          const elements = await view.executeJavaScript(`(() => {
            const path = (el) => {
              const parts = [];
              let node = el;
              while (node !== null && node.nodeType === 1 && parts.length < 6) {
                let part = node.tagName.toLowerCase();
                if (node.id) { parts.unshift(part + '#' + node.id); break; }
                const parent = node.parentElement;
                if (parent !== null) {
                  const same = [...parent.children].filter((child) => child.tagName === node.tagName);
                  if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
                }
                parts.unshift(part);
                node = parent;
              }
              return parts.join(' > ');
            };
            return [...document.querySelectorAll('a[href],button,input,textarea,select,summary,[role=button],[role=link],[contenteditable=true]')]
              .filter((el) => { const rect = el.getBoundingClientRect(); return rect.width > 1 && rect.height > 1; })
              .slice(0, 80)
              .map((el) => ({ tag: el.tagName.toLowerCase(), selector: path(el), text: (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '').replace(/\\s+/g, ' ').trim().slice(0, 120), href: el.getAttribute('href') || undefined }));
          })()`);
          const list = Array.isArray(elements) ? elements : [];
          return { ...base, elements: list, text: clamp(list.map((element) => `- ${element.selector} — ${element.text}${element.href !== undefined ? ` (${element.href})` : ''}`).join('\n'), limit) };
        }
        case 'eval': {
          if (typeof args?.code !== 'string' || args.code.trim().length === 0) throw new Error('eval 需要一个 code 参数。');
          const value = await view.executeJavaScript(args.code, true);
          return { ...base, value: clampValue(value, limit) };
        }
        case 'click': {
          const selector = typeof args?.selector === 'string' && args.selector.length > 0 ? args.selector : undefined;
          const wanted = typeof args?.text === 'string' && args.text.length > 0 ? args.text : undefined;
          if (selector === undefined && wanted === undefined) throw new Error('click 需要 selector 或 text 参数。');
          const outcome = await view.executeJavaScript(`(() => {
            const el = ${matchExpression(selector, wanted)};
            if (el === null) return { ok: false, reason: 'not-found' };
            el.scrollIntoView({ block: 'center', inline: 'center' });
            el.click();
            return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) };
          })()`, true);
          if (outcome?.ok !== true) throw new Error(`没有找到可点击的目标（${selector ?? wanted}）。可先用 browser_page 的 elements 查看可用元素。`);
          return { ...base, value: outcome, url: frameUrl(view), note: '已派发点击。' };
        }
        case 'type': {
          if (typeof args?.text !== 'string') throw new Error('type 需要一个 text 参数。');
          const selector = typeof args?.selector === 'string' && args.selector.length > 0 ? args.selector : undefined;
          const submit = args?.submit === true;
          const outcome = await view.executeJavaScript(`(() => {
            const el = ${selector !== undefined ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement'};
            if (el === null || el === undefined || !('value' in el)) return { ok: false, reason: 'not-editable' };
            el.focus();
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter !== undefined) setter.call(el, ${JSON.stringify(args.text)}); else el.value = ${JSON.stringify(args.text)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (${submit ? 'true' : 'false'}) {
              const form = el.form;
              if (form !== null && form !== undefined && typeof form.requestSubmit === 'function') form.requestSubmit();
              else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            }
            return { ok: true, tag: el.tagName.toLowerCase(), value: el.value };
          })()`, true);
          if (outcome?.ok !== true) throw new Error('没有找到可输入的输入框（可用 selector 指定，或先 click 聚焦它）。');
          return { ...base, value: { tag: outcome.tag, value: String(outcome.value ?? '').slice(0, 200) }, note: submit ? '已填写并提交。' : '已填写。' };
        }
        case 'scroll': {
          const pixels = Number.isFinite(args?.ms) ? Math.trunc(args.ms) : 0;
          await view.executeJavaScript(`(() => { window.scrollBy({ top: ${pixels} === 0 ? Math.round(window.innerHeight * 0.9) : ${pixels}, behavior: 'smooth' }); return true; })()`);
          await sleep(450);
          const position = await view.executeJavaScript('(() => ({ x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight, viewport: window.innerHeight }))()');
          return { ...base, value: position };
        }
        case 'wait': {
          const timeout = Number.isFinite(args?.ms) ? Math.max(200, Math.min(60_000, Math.trunc(args.ms))) : 10_000;
          const selector = typeof args?.selector === 'string' && args.selector.length > 0 ? args.selector : undefined;
          const wanted = typeof args?.text === 'string' && args.text.length > 0 ? args.text : undefined;
          const condition = selector !== undefined || wanted !== undefined
            ? `(() => { const el = ${matchExpression(selector, wanted)}; return el !== null; })()`
            : '(() => document.readyState === "complete")()';
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const ready = await view.executeJavaScript(condition);
            if (ready === true) return { ...base, note: '条件已满足。' };
            await sleep(250);
          }
          throw new Error(`等待超时（${timeout}ms）：${selector ?? wanted ?? '页面加载'} 未出现。`);
        }
        case 'screenshot':
          throw new Error('本插件不提供截图：webview.capturePage() 会让 Electron 渲染进程原生崩溃（已实测），因此该能力被刻意移除。需要页面图像时，用 browser_control 的 external 在系统浏览器中打开。');
        default:
          throw new Error(`未知的 page 动作：${action}`);
      }
    }

    /**
     * Execute one command from the Host half.
     * @param command - `{ id, op, args }`.
     * @returns the operation result.
     */
    async function execute(command) {
      switch (command.op) {
        case 'tabs':
          return listTabs();
        case 'control':
          return await control(command.args ?? {});
        case 'page':
          return await page(command.args ?? {});
        default:
          throw new Error(`未知的内置浏览器操作：${command.op}`);
      }
    }

    /**
     * Report one settled command back to the Host half.
     * @param id - command id.
     * @param ok - whether the operation succeeded.
     * @param value - result value.
     * @param error - failure message.
     */
    async function report(id, ok, value, error) {
      try {
        await fetch(`${BASE}/result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId: state.clientId, id, ok, value: ok ? value : undefined, error: ok ? undefined : error })
        });
      } catch (failure) {
        console.error('[sidebar-browser-control] 汇报结果失败', failure);
      }
    }

    /**
     * Run one command and report its outcome.
     * @param command - `{ id, op, args }`.
     */
    async function run(command) {
      try {
        const value = await execute(command);
        await report(command.id, true, value === undefined ? null : value, undefined);
      } catch (error) {
        await report(command.id, false, undefined, String(error?.message ?? error));
      }
    }

    /** Commands run one at a time, so two calls cannot interleave inside one page. */
    let queue = Promise.resolve();

    /**
     * Queue one command behind the commands already running.
     * @param command - `{ id, op, args }`.
     */
    function enqueue(command) {
      queue = queue.then(() => run(command), () => run(command));
    }

    /** Announce this page to the Host half and keep one long-poll open. */
    async function bridge() {
      while (!state.stopped) {
        try {
          if (state.clientId === undefined) {
            const answer = await fetch(`${BASE}/hello`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                platform: platformName(),
                capabilities: capabilities(),
                href: location.href
              })
            });
            const body = await answer.json();
            if (body?.ok !== true || typeof body.clientId !== 'string') throw new Error('握手被拒绝');
            state.clientId = body.clientId;
            state.refusals = 0;
          }
          const answer = await fetch(`${BASE}/poll?clientId=${encodeURIComponent(state.clientId)}&focus=${document.hasFocus() ? 1 : 0}`, { cache: 'no-store' });
          if (answer.status === 410) {
            state.clientId = undefined;
            continue;
          }
          if (!answer.ok) throw new Error(`poll ${answer.status}`);
          const body = await answer.json();
          const commands = Array.isArray(body?.commands) ? body.commands : [];
          for (const command of commands) enqueue(command);
        } catch (error) {
          state.refusals += 1;
          if (state.refusals <= 2) console.error('[sidebar-browser-control] 与宿主的桥接中断，稍后重试', error);
          state.clientId = undefined;
          await sleep(Math.min(RETRY_MS * state.refusals, 8000));
        }
      }
    }

    return {
      apply(pluginContext) {
        context = pluginContext;
        pluginContext.effect(() => {
          state.stopped = false;
          void bridge();
          return () => {
            state.stopped = true;
          };
        }, 'sidebar-browser-control.bridge');
      }
    };
  }
});
