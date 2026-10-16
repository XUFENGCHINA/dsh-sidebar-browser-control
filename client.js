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

    /** @param frame - a carrier element, possibly absent. @returns whether it is the Electron webview. */
    function isWebview(frame) {
      return frame !== undefined && frame !== null && typeof frame.tagName === 'string' && frame.tagName.toLowerCase() === 'webview';
    }

    /** @param frame - a carrier element. @returns its current address, when readable. */
    function frameUrl(frame) {
      if (frame === undefined) return undefined;
      try {
        if (isWebview(frame)) {
          const url = frame.getURL();
          /* A guest is created at `about:blank#<lease>`; that is not an address. */
          return typeof url === 'string' && /^https?:/u.test(url) ? url : undefined;
        }
        const src = frame.getAttribute('src');
        return src === null || !/^https?:/u.test(src) ? undefined : new URL(src, location.href).href;
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

    /**
     * What this page can actually do about pixels.
     *
     * Screenshots are the one capability with a native failure mode, so the
     * answer is reported instead of guessed: `guest` is the webview's own
     * `capturePage` (crashed the renderer once — see docs/architecture.md),
     * `window` needs a renderer capture API, `dom` is the pure-JS fallback.
     * @returns a diagnostic snapshot of the available capture routes.
     */
    function captureRoutes() {
      const carrier = globalThis.dshDesktop;
      return {
        guest: typeof document.createElement('webview').capturePage === 'function',
        desktop_capturer: typeof globalThis.desktopCapturer?.getSources === 'function',
        display_media: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
        carrier_keys: carrier === undefined || carrier === null ? [] : Object.keys(carrier).slice(0, 20)
      };
    }

    /** @returns every Browser tab, with the addresses its carrier can report. */
    function listTabs() {
      const service = sidebar();
      const screen = onScreenSession();
      const active = activeTabEntry();
      const capture = captureRoutes();
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
        capture,
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
        throw new Error(`标签页 ${entry.handle} 当前没有已挂载的页面：它可能是重启后尚未加载、在别的会话、或已收起。用 browser_control 的 navigate 指定地址即可加载它（reload 可重载已保存的地址）。`);
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
     * In-page helpers shared by every form-aware action.
     *
     * Login forms are the reason these exist: fields have to be found by label,
     * name, placeholder or autocomplete rather than by a hand-written selector,
     * and the form itself may live in a same-origin iframe.
     * @returns JavaScript source declaring `visible`, `docs`, `labelled`,
     * `fields`, `findField`, `setValue` and `submitForm`.
     */
    function pageHelpers() {
      return `
        const visible = (el) => { const rect = el.getBoundingClientRect(); return rect.width > 1 && rect.height > 1; };
        const docs = () => {
          const list = [document];
          for (const frame of document.querySelectorAll('iframe')) {
            try { if (frame.contentDocument !== null) list.push(frame.contentDocument); } catch (error) { /* cross-origin */ }
          }
          return list;
        };
        const labelled = (el) => {
          const parts = [];
          if (el.id !== undefined && el.id.length > 0) {
            const root = el.ownerDocument;
            const label = root.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]');
            if (label !== null) parts.push(label.innerText);
          }
          const wrapping = el.closest === undefined ? null : el.closest('label');
          if (wrapping !== null && wrapping !== undefined) parts.push(wrapping.innerText);
          for (const attribute of ['aria-label', 'placeholder', 'title', 'name', 'id']) {
            const value = el.getAttribute === undefined ? null : el.getAttribute(attribute);
            if (typeof value === 'string' && value.length > 0) parts.push(value);
          }
          return parts.join(' ').replace(/\\s+/g, ' ').trim().slice(0, 160);
        };
        const fields = () => {
          const list = [];
          for (const doc of docs()) {
            for (const el of doc.querySelectorAll('input,textarea,select')) {
              if (el.type === 'hidden' || !visible(el)) continue;
              list.push(el);
            }
          }
          return list;
        };
        const describe = (el) => ({
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase(),
          name: el.getAttribute('name') || undefined,
          id: el.id || undefined,
          autocomplete: el.getAttribute('autocomplete') || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          label: labelled(el),
          value: el.type === 'password' ? '' : String(el.value ?? '').slice(0, 60),
          checked: el.checked === undefined ? undefined : el.checked
        });
        /* Resolve one field description to an element: explicit selector, then
           the semantic signals a login form actually carries. */
        const findField = (spec) => {
          const pool = fields();
          const selector = typeof spec.selector === 'string' ? spec.selector : '';
          if (selector.length > 0) {
            for (const doc of docs()) {
              const found = doc.querySelector(selector);
              if (found !== null) return found;
            }
            return null;
          }
          const wanted = String(spec.name || spec.label || spec.placeholder || spec.type || '').toLowerCase();
          if (wanted.length === 0) return null;
          const scored = pool.map((el) => {
            const info = describe(el);
            const haystack = [info.name, info.id, info.placeholder, info.label, info.autocomplete, info.type]
              .filter((part) => typeof part === 'string').join(' ').toLowerCase();
            let score = 0;
            if (info.type === wanted) score += 4;
            if (info.name !== undefined && info.name.toLowerCase() === wanted) score += 8;
            if (haystack.includes(wanted)) score += 3;
            if (wanted === 'password' && info.type === 'password') score += 10;
            if (wanted === 'username' && /user|email|phone|account|login|mobile/i.test(haystack)) score += 6;
            return { el, score };
          }).filter((candidate) => candidate.score > 0);
          scored.sort((left, right) => right.score - left.score);
          return scored.length === 0 ? null : scored[0].el;
        };
        const setValue = (el, value) => {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter !== undefined) setter.call(el, value); else el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const submitForm = (el) => {
          const form = el.form ?? (el.closest === undefined ? null : el.closest('form'));
          if (form !== null && form !== undefined && typeof form.requestSubmit === 'function') { form.requestSubmit(); return true; }
          const button = el.ownerDocument.querySelector('button[type=submit],input[type=submit],button:not([type])');
          if (button !== null && button !== undefined) { button.click(); return true; }
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          return false;
        };
      `;
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
        if (wanted === null || wanted.length === 0) return null;
        const nodes = [...document.querySelectorAll('a,button,input,textarea,select,summary,label,li,td,th,span,div,p,[role=button],[role=link],[tabindex]')];
        const read = (node) => (node.innerText || node.value || node.textContent || '').replace(/\\s+/g, ' ').trim();
        const actionable = (node) => node.matches('a[href],button,input,select,textarea,summary,[role=button],[role=link]');
        const matches = nodes.filter((node) => { const value = read(node); return value === wanted || value.includes(wanted); });
        if (matches.length === 0) return null;
        /* Rank: exact text, then something clickable, then the smallest match —
           so a link beats the container that merely contains its text. */
        const score = (node) => {
          const value = read(node);
          return [value === wanted ? 0 : 1, actionable(node) ? 0 : 1, value.length];
        };
        matches.sort((left, right) => {
          const a = score(left);
          const b = score(right);
          for (let index = 0; index < a.length; index += 1) {
            if (a[index] !== b[index]) return a[index] - b[index];
          }
          return 0;
        });
        return matches[0];
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
     * Inspect the document a command is about to act on.
     *
     * A failed load leaves Chromium's error page in the webview, where every
     * extraction legitimately returns nothing — which reads to a model as "the
     * page is empty". This makes that state visible instead.
     * @param view - carrier element.
     * @returns `{ failed, href, title, empty }` for the loaded document.
     */
    async function inspectPage(view) {
      let state;
      try {
        state = await view.executeJavaScript('(() => ({ href: location.href, protocol: location.protocol, title: document.title, body: (document.body === null ? "" : document.body.innerText).slice(0, 60) }))()');
      } catch {
        return { failed: false, href: frameUrl(view) ?? '', title: frameTitle(view), empty: false };
      }
      const href = typeof state?.href === 'string' ? state.href : '';
      const protocol = typeof state?.protocol === 'string' ? state.protocol : '';
      return {
        failed: href.startsWith('chrome-error:') || protocol === 'chrome-error:',
        href,
        title: typeof state?.title === 'string' ? state.title : '',
        empty: typeof state?.body === 'string' && state.body.trim().length === 0
      };
    }

    /**
     * Refuse to act on a document that never loaded.
     * @param state - result of {@link inspectPage}.
     * @param action - page action name, for the message.
     */
    function requireLoaded(state, action) {
      if (!state.failed) return;
      throw new Error(`页面没有加载成功（内置浏览器里是 Chromium 错误页，通常是 DNS、网络或证书失败），"${action}" 没有内容可操作。可以先用 browser_control 的 reload 重试，或用 external 交给系统浏览器。`);
    }

    /**
     * Wait for a freshly opened tab to commit its first document, so the
     * reported title and address belong to the page rather than to the guest's
     * creation state (`about:blank#<lease>`, whose "title" is that string).
     * @param frame - carrier element, when it is already mounted.
     * @param timeoutMs - how long to wait for a committed document.
     * @returns `{ title, url }` as observed; both empty/undefined until commit.
     */
    async function waitForCommit(frame, timeoutMs = 4000) {
      if (frame === undefined) return { title: '', url: undefined };
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const url = frameUrl(frame);
        const title = frameTitle(frame);
        const committed = url !== undefined && title.length > 0 && !title.startsWith('about:');
        if (committed || Date.now() >= deadline) {
          return { title: title.startsWith('about:') ? '' : title, url };
        }
        await sleep(150);
      }
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
          const committed = await waitForCommit(frame);
          return {
            action,
            tab_id: entry?.handle,
            session: entry?.sessionId,
            url: committed.url ?? url,
            title: committed.title || (entry === undefined ? undefined : recordFor(entry)?.title)
          };
        }
        case 'navigate': {
          if (url === undefined) throw new Error('navigate 需要一个 url 参数。');
          const target = requested === undefined ? defaultEntry() : findEntry(requested);
          if (target === undefined) return await control({ action: 'open', url: args.url });
          const frame = frameFor(target.tabId, target.sessionId);
          if (isWebview(frame)) {
            try {
              await frame.loadURL(url);
            } catch (error) {
              /* A failed load still leaves the tab at that address, showing
                 Chromium's error page; report it instead of failing the call. */
              const failed = await inspectPage(frame);
              return {
                action,
                tab_id: target.handle,
                url: frameUrl(frame) ?? url,
                note: failed.failed
                  ? `页面加载失败（${String(error?.message ?? error)}）：内置浏览器停在了 Chromium 错误页，通常是 DNS、网络或证书问题。可以换一个地址，或先用 external 交给系统浏览器。`
                  : `导航被中断：${String(error?.message ?? error)}`
              };
            }
            const committed = await waitForCommit(frame, 2000);
            return { action, tab_id: target.handle, url: committed.url ?? url, title: committed.title };
          }
          /* A tab restored after a restart has no carrier until something loads
             it, so a missing frame is a load request rather than an error. DSH's
             replace rule closes the old tab and opens a new one, which means the
             caller must be given the NEW id — the old one is already gone. */
          const screen = onScreenSession();
          if (target.sessionId !== screen) {
            throw new Error(`标签页 ${target.handle} 属于另一个会话，无法从当前会话加载它。请先切换到那个会话（或在当前会话里用 open 打开同样的地址）。`);
          }
          const known = new Set(browserEntries().map((entry) => entry.handle));
          service.openTab('browser', { params: { url }, replaceTab: target.tabId, revealIfOpened: false });
          const fresh = (await waitForNewEntry(known, screen)) ?? target;
          await waitForFrame(fresh.tabId, fresh.sessionId, 3000);
          const loaded = await waitForCommit(frameFor(fresh.tabId, fresh.sessionId), 2500);
          return {
            action,
            tab_id: fresh.handle,
            url: loaded.url ?? url,
            title: loaded.title,
            note: fresh.handle === target.handle
              ? undefined
              : `原标签 ${target.handle} 重启后尚未加载页面，已由新标签 ${fresh.handle} 加载它（DSH 的替换语义会新建标签）。请用 ${fresh.handle} 继续。`
          };
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
      const state = await inspectPage(view);
      const base = { action, tab_id: entry.handle, url: frameUrl(view), title: frameTitle(view) };
      const pageNote = state.failed
        ? '页面是 Chromium 错误页（加载失败），内容为空是正常的：可用 browser_control 的 reload 重试。'
        : undefined;

      switch (action) {
        case 'text': {
          requireLoaded(state, action);
          const text = await view.executeJavaScript('(() => { const body = document.body; return body === null ? "" : body.innerText; })()');
          const rendered = typeof text === 'string' ? text : JSON.stringify(text);
          return {
            ...base,
            text: clamp(rendered, limit),
            note: rendered.trim().length === 0
              ? '页面正文为空：可能是跳转还没完成（试试 wait）或内容由脚本延迟渲染（试试 eval 读具体节点）。'
              : undefined
          };
        }
        case 'links': {
          requireLoaded(state, action);
          const links = await view.executeJavaScript('(() => [...document.querySelectorAll("a[href]")].slice(0, 300).map((node) => ({ text: (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160), href: node.href })).filter((link) => link.href.startsWith("http")))()');
          const list = (Array.isArray(links) ? links : []).slice(0, 120);
          return { ...base, links: list, note: list.length === 0 ? '页面里没有 http(s) 链接。' : undefined };
        }
        case 'elements': {
          requireLoaded(state, action);
          const elements = await view.executeJavaScript(`(() => {
            ${pageHelpers()}
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
            const nodes = [];
            for (const doc of docs()) {
              for (const el of doc.querySelectorAll('a[href],button,input,textarea,select,summary,[role=button],[role=link],[contenteditable=true]')) {
                if (visible(el)) nodes.push(el);
              }
            }
            return nodes.slice(0, 80).map((el) => {
              const info = describe(el);
              return {
                tag: info.tag,
                type: info.type,
                selector: path(el),
                text: (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
                name: info.name,
                placeholder: info.placeholder,
                label: info.label || undefined,
                autocomplete: info.autocomplete,
                value: info.value || undefined,
                checked: info.checked,
                href: el.getAttribute('href') || undefined
              };
            });
          })()`);
          const list = Array.isArray(elements) ? elements : [];
          return { ...base, elements: list, note: list.length === 0 ? '这个页面没有可交互元素（或它们都不可见）。' : undefined };
        }
        case 'fill': {
          requireLoaded(state, action);
          const specs = Array.isArray(args?.fields) ? args.fields : [];
          if (specs.length === 0) throw new Error('fill 需要一个 fields 数组，例如 [{ label: "username", value: "alice" }, { label: "password", value: "…" }]。');
          const outcome = await view.executeJavaScript(`(() => {
            ${pageHelpers()}
            const specs = ${JSON.stringify(specs)};
            const report = [];
            let last = null;
            for (const spec of specs) {
              const el = findField(spec);
              if (el === null) { report.push({ target: spec.selector || spec.label || spec.name || spec.placeholder || spec.type, ok: false, reason: 'not-found' }); continue; }
              if (spec.value === undefined || spec.value === null) { report.push({ target: spec.selector || spec.label, ok: false, reason: 'no-value' }); continue; }
              if (el.type === 'checkbox' || el.type === 'radio') {
                const wanted = spec.value === true || spec.value === 'true' || spec.value === 'on';
                if (el.checked !== wanted) el.click();
                report.push({ target: spec.selector || spec.label || spec.name, ok: true, kind: el.type, checked: el.checked });
              } else if (el.tagName === 'SELECT') {
                el.value = String(spec.value);
                el.dispatchEvent(new Event('change', { bubbles: true }));
                report.push({ target: spec.selector || spec.label || spec.name, ok: true, kind: 'select', value: String(el.value) });
              } else {
                el.focus();
                setValue(el, String(spec.value));
                report.push({ target: spec.selector || spec.label || spec.name, ok: true, kind: el.type, filled: el.type === 'password' ? '••••' : String(el.value).slice(0, 40) });
              }
              last = el;
            }
            let submitted = false;
            if (${args?.submit === true ? 'true' : 'false'} && last !== null) submitted = submitForm(last);
            return { report, submitted };
          })()`, true);
          const filled = Array.isArray(outcome?.report) ? outcome.report.filter((entry) => entry.ok).length : 0;
          const missing = Array.isArray(outcome?.report) ? outcome.report.filter((entry) => entry.ok !== true) : [];
          const settled = outcome?.submitted === true ? await settle(view, base.url, 5000) : base.url;
          return {
            ...base,
            value: outcome,
            url: settled,
            title: frameTitle(view),
            note: `${filled}/${specs.length} 个字段已填写${outcome?.submitted === true ? '并已提交表单' : ''}。${missing.length > 0 ? `未找到：${missing.map((entry) => entry.target).join('、')}（先用 elements 看可用字段）。` : ''} 密码不会出现在任何返回值里。`
          };
        }
        case 'key': {
          requireLoaded(state, action);
          const key = typeof args?.key === 'string' && args.key.length > 0 ? args.key : 'Enter';
          const selector = typeof args?.selector === 'string' && args.selector.length > 0 ? args.selector : undefined;
          const outcome = await view.executeJavaScript(`(() => {
            ${pageHelpers()}
            const el = ${selector !== undefined ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement'};
            const target = el === null || el === undefined ? document.body : el;
            if (target.focus !== undefined) target.focus();
            const key = ${JSON.stringify(key)};
            const code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
            const init = { key, code, keyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0, which: 0, bubbles: true, cancelable: true };
            target.dispatchEvent(new KeyboardEvent('keydown', init));
            target.dispatchEvent(new KeyboardEvent('keypress', init));
            target.dispatchEvent(new KeyboardEvent('keyup', init));
            const submitted = key === 'Enter' && target.tagName !== 'TEXTAREA' ? submitForm(target) : false;
            return { key, tag: target.tagName.toLowerCase(), submitted };
          })()`, true);
          const submittedKey = outcome?.submitted === true;
          const settledKey = submittedKey ? await settle(view, base.url, 5000) : base.url;
          return { ...base, value: outcome, url: settledKey, title: frameTitle(view), note: submittedKey ? `已按下 ${key} 并提交所在表单。` : `已按下 ${key}。` };
        }
        case 'login': {
          requireLoaded(state, action);
          const user = typeof args?.user === 'string' ? args.user : undefined;
          const password = typeof args?.password === 'string' ? args.password : undefined;
          if (user === undefined || password === undefined) throw new Error('login 需要 user 和 password 两个参数（密码只用于这一次填写，不会存入日志或返回）。');
          const userSelector = typeof args?.user_selector === 'string' && args.user_selector.length > 0 ? args.user_selector : undefined;
          const passwordSelector = typeof args?.password_selector === 'string' && args.password_selector.length > 0 ? args.password_selector : undefined;
          const pre = await view.executeJavaScript(`(() => {
            ${pageHelpers()}
            const list = fields().map(describe);
            return { hasPassword: list.some((field) => field.type === 'password'), fields: list.slice(0, 12) };
          })()`);
          if (pre?.hasPassword !== true && passwordSelector === undefined) {
            throw new Error('这个页面里没有可见的密码输入框（可能已经登录，或登录表单在跨域 iframe 里）。先用 elements 确认。');
          }
          const outcome = await view.executeJavaScript(`(() => {
            ${pageHelpers()}
            const password = findField({ selector: ${JSON.stringify(passwordSelector ?? null)}, type: 'password' });
            let account = findField({ selector: ${JSON.stringify(userSelector ?? null)}, type: 'username' });
            if (account === null && password !== null) {
              /* The account field is normally the last text input before the password. */
              const before = fields().filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING || el === password);
              const textish = before.filter((el) => ['text', 'email', 'tel', 'number', ''].includes((el.getAttribute('type') || '').toLowerCase()) || el.tagName === 'INPUT');
              account = textish.length > 0 ? textish[textish.length - 1] : null;
            }
            const report = [];
            if (account !== null && account !== undefined) { account.focus(); setValue(account, ${JSON.stringify(user)}); report.push({ field: 'account', ok: true, name: describe(account).name ?? describe(account).label ?? '' }); }
            else report.push({ field: 'account', ok: false });
            if (password !== null && password !== undefined) { password.focus(); setValue(password, ${JSON.stringify(password)}); report.push({ field: 'password', ok: true }); }
            else report.push({ field: 'password', ok: false });
            const submitted = password !== null && password !== undefined ? submitForm(password) : false;
            return { report, submitted };
          })()`, true);
          const accountOk = Array.isArray(outcome?.report) && outcome.report.some((entry) => entry.field === 'account' && entry.ok === true);
          const passwordOk = Array.isArray(outcome?.report) && outcome.report.some((entry) => entry.field === 'password' && entry.ok === true);
          const before = base.url;
          const settledUrl = await settle(view, before, 8000);
          const after = await view.executeJavaScript(`(() => {
            ${pageHelpers()}
            const list = fields().map(describe);
            const body = (document.body === null ? '' : document.body.innerText).slice(0, 4000);
            return {
              hasPassword: list.some((field) => field.type === 'password'),
              signals: /log ?out|sign ?out|退出|注销|我的账号|my account|profile|dashboard/i.test(body) ? 'account-ui' : undefined,
              error: /incorrect|invalid|wrong password|密码错误|验证码|错误|失败|captcha|验证/i.test(body) ? 'page-reports-a-problem' : undefined
            };
          })()`);
          /* A login form inside an iframe navigates the frame, not the tab, so
             both the frame's fields and the top document are re-checked. */
          const frameLanded = await view.executeJavaScript(`(() => {
            for (const doc of (() => {
              const list = [document];
              for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument !== null) list.push(frame.contentDocument); } catch (error) { /* cross-origin */ } }
              return list;
            })()) {
              const text = (doc.body === null ? '' : doc.body.innerText).slice(0, 2000);
              if (/欢迎|welcome|dashboard|账号中心|已登录/i.test(text)) return { landed: true, url: doc.location.href, excerpt: text.replace(/\\s+/g, ' ').trim().slice(0, 120) };
            }
            return { landed: false };
          })()`);
          return {
            ...base,
            url: settledUrl,
            value: {
              filled_account: accountOk,
              filled_password: passwordOk,
              submitted: outcome?.submitted === true,
              password_field_gone: after?.hasPassword === false,
              landed: frameLanded?.landed === true ? frameLanded.url : undefined,
              signal: after?.signals,
              warning: after?.error
            },
            title: frameTitle(view),
            note: [
              accountOk && passwordOk ? '账号与密码已填写' : `字段查找：账号${accountOk ? '✓' : '✗'} 密码${passwordOk ? '✓' : '✗'}（可用 *_selector 明确指定）`,
              outcome?.submitted === true ? '已提交' : '未提交（请检查提交按钮，或用 click 点它）',
              frameLanded?.landed === true ? `已看到登录后的页面内容：${frameLanded.excerpt}` : undefined,
              after?.hasPassword === false ? '登录框已消失，通常表示登录成功' : undefined,
              after?.signals === 'account-ui' ? '页面上出现了账号相关文字，可进一步确认' : undefined,
              after?.error === 'page-reports-a-problem' ? '页面文字里出现了错误/验证码类提示，可能需要人工处理' : undefined
            ].filter((part) => typeof part === 'string').join('；')
          };
        }
        case 'images': {
          requireLoaded(state, action);
          const images = await view.executeJavaScript(`(() => {
            const out = [];
            for (const el of document.querySelectorAll('img,picture source,svg image,canvas')) {
              const rect = el.getBoundingClientRect();
              if (!(rect.width > 1 && rect.height > 1 && rect.bottom > -50 && rect.top < window.innerHeight + 50)) continue;
              const source = el.currentSrc || el.src || '';
              out.push({
                index: out.length + 1,
                tag: el.tagName.toLowerCase(),
                alt: el.getAttribute('alt') || undefined,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                natural_width: el.naturalWidth || undefined,
                natural_height: el.naturalHeight || undefined,
                src: String(source).slice(0, 200)
              });
              if (out.length >= 40) break;
            }
            return out;
          })()`);
          const list = Array.isArray(images) ? images : [];
          return {
            ...base,
            images: list,
            note: list.length === 0
              ? '当前视口里没有可见图片（可以先 scroll 或 wait 再试）。'
              : '用 browser_page { action: "image", index: N } 就能直接看到其中一张。'
          };
        }
        case 'eval': {
          if (typeof args?.code !== 'string' || args.code.trim().length === 0) throw new Error('eval 需要一个 code 参数。');
          const value = await view.executeJavaScript(args.code, true);
          return { ...base, value: clampValue(value, limit), note: pageNote };
        }
        case 'click': {
          const selector = typeof args?.selector === 'string' && args.selector.length > 0 ? args.selector : undefined;
          const wanted = typeof args?.text === 'string' && args.text.length > 0 ? args.text : undefined;
          if (selector === undefined && wanted === undefined) throw new Error('click 需要 selector 或 text 参数。');
          requireLoaded(state, action);
          const before = new Set(browserEntries().map((candidate) => candidate.handle));
          const outcome = await view.executeJavaScript(`(() => {
            const el = ${matchExpression(selector, wanted)};
            if (el === null) return { ok: false, reason: 'not-found' };
            el.scrollIntoView({ block: 'center', inline: 'center' });
            el.click();
            return {
              ok: true,
              tag: el.tagName.toLowerCase(),
              text: (el.innerText || el.value || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
              target: el.getAttribute('target') || undefined,
              actionable: el.matches('a[href],button,input,select,textarea,summary,[role=button],[role=link]')
            };
          })()`, true);
          if (outcome?.ok !== true) throw new Error(`没有找到可点击的目标（${selector ?? wanted}）。可先用 browser_page 的 elements 查看可用元素。`);
          await sleep(700);
          const opened = browserEntries().find((candidate) => !before.has(candidate.handle));
          if (opened !== undefined) {
            const openedFrame = (await waitForFrame(opened.tabId, opened.sessionId, 3000)) ?? undefined;
            const committed = await waitForCommit(openedFrame, 2500);
            return {
              ...base,
              value: outcome,
              url: await settle(view, base.url, 2000),
              opened_tab: opened.handle,
              opened_url: committed.url,
              opened_title: committed.title,
              note: `该链接在新标签页打开：DSH 把 popup 请求变成了新的侧栏标签 ${opened.handle}。请用它继续操作，原标签 ${entry.handle} 仍停在当前页面。`
            };
          }
          const settledUrl = await settle(view, base.url, 3000);
          const stalled = outcome.actionable === false && settledUrl === base.url;
          return {
            ...base,
            value: outcome,
            url: settledUrl,
            note: stalled
              ? `点击的元素不是链接或按钮（匹配到的是 <${outcome.tag}> 这样的外层容器），页面没有任何变化。请改用 browser_page 的 elements 取一个精确 selector，再点那个链接或按钮。`
              : '已派发点击。'
          };
        }
        case 'type': {
          if (typeof args?.text !== 'string') throw new Error('type 需要一个 text 参数。');
          requireLoaded(state, action);
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
          requireLoaded(state, action);
          const pixels = Number.isFinite(args?.ms) ? Math.trunc(args.ms) : 0;
          await view.executeJavaScript(`(() => { window.scrollBy({ top: ${pixels} === 0 ? Math.round(window.innerHeight * 0.9) : ${pixels}, behavior: 'smooth' }); return true; })()`);
          await sleep(450);
          const position = await view.executeJavaScript('(() => ({ x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight, viewport: window.innerHeight }))()');
          return { ...base, value: position };
        }
        case 'wait': {
          requireLoaded(state, action);
          const timeout = Number.isFinite(args?.ms) ? Math.max(200, Math.min(60_000, Math.trunc(args.ms))) : 10_000;
          const selector = typeof args?.selector === 'string' && args.selector.length > 0 ? args.selector : undefined;
          const wanted = typeof args?.text === 'string' && args.text.length > 0 ? args.text : undefined;
          const urlWanted = typeof args?.url_contains === 'string' && args.url_contains.length > 0 ? args.url_contains : undefined;
          const condition = selector !== undefined || wanted !== undefined
            ? `(() => { const el = ${matchExpression(selector, wanted)}; return el !== null; })()`
            : '(() => document.readyState === "complete")()';
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            if (urlWanted !== undefined && (frameUrl(view) ?? '').includes(urlWanted)) {
              return { ...base, url: frameUrl(view), note: `网址已包含 ${urlWanted}。` };
            }
            const ready = urlWanted === undefined ? await view.executeJavaScript(condition) : false;
            if (ready === true) return { ...base, note: '条件已满足。' };
            await sleep(250);
          }
          throw new Error(`等待超时（${timeout}ms）：${urlWanted !== undefined ? `网址未包含 ${urlWanted}` : `${selector ?? wanted ?? '页面加载'} 未出现`}。`);
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
        case 'geometry':
          return geometry(command.args ?? {});
        case 'image':
          return await image(command.args ?? {});
        default:
          throw new Error(`未知的内置浏览器操作：${command.op}`);
      }
    }

    /**
     * Where the Browser pane sits inside the DSH window.
     *
     * The Host half captures the window itself (there is no safe in-renderer
     * capture API), so it needs the pane's viewport rectangle plus the frame
     * offsets that separate the viewport from the window rectangle.
     * @param args - `{ tab_id? }`.
     * @returns geometry for the Host's crop maths.
     */
    function geometry(args) {
      const { frame, entry } = resolveTarget(args);
      const rect = frame.getBoundingClientRect();
      return {
        tab_id: entry.handle,
        url: frameUrl(frame),
        title: frameTitle(frame),
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        devicePixelRatio: window.devicePixelRatio || 1,
        outer: {
          width: window.outerWidth,
          height: window.outerHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight
        }
      };
    }

    /**
     * Hand the Host one picture from the page so it can attach it to a result.
     *
     * Bytes travel from the Host, not from here: the page's own `fetch` is bound
     * by CORS, while the Host's Node fetch is not. Only `data:` and `blob:`
     * sources — which the Host cannot read — are decoded in the page.
     * @param args - `{ tab_id?, index?, selector?, src? }`.
     * @returns `{ url }` for the Host to fetch, or `{ inline, media_type }`.
     */
    async function image(args) {
      const { frame, entry } = resolveTarget(args);
      requireWebview(frame);
      const index = Number.isFinite(args?.index) ? Math.trunc(args.index) : undefined;
      const selector = typeof args?.selector === 'string' && args.selector.length > 0 ? args.selector : undefined;
      const wanted = typeof args?.src === 'string' && args.src.length > 0 ? args.src : undefined;
      if (index === undefined && selector === undefined && wanted === undefined) {
        throw new Error('image 需要 index（来自 images）、selector 或 src 之一。');
      }
      const found = await frame.executeJavaScript(`(() => {
        /* Same ordering as the images action: viewport-visible pictures only. */
        const all = [...document.querySelectorAll('img,picture source,svg image,canvas')].filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 1 && rect.height > 1 && rect.bottom > -50 && rect.top < window.innerHeight + 50;
        });
        const pick = ${index !== undefined ? `all[${index - 1}] ?? null` : 'null'};
        const bySelector = ${selector !== undefined ? `document.querySelector(${JSON.stringify(selector)})` : 'null'};
        const el = pick ?? bySelector ?? null;
        if (el === null) return { ok: false };
        const toBlobSource = ${wanted !== undefined ? JSON.stringify(wanted) : 'null'};
        const source = toBlobSource ?? el.currentSrc ?? el.src ?? (el.tagName === 'CANVAS' ? el.toDataURL('image/png') : null);
        if (source === null || source === undefined || String(source).length === 0) return { ok: false, reason: 'no-source' };
        const rect = el.getBoundingClientRect();
        return {
          ok: true,
          src: String(source),
          alt: el.getAttribute('alt') || undefined,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          natural_width: el.naturalWidth || undefined,
          natural_height: el.naturalHeight || undefined,
          tag: el.tagName.toLowerCase()
        };
      })()`);
      if (found?.ok !== true) throw new Error('没有找到这张图片（先用 images 看列表，或用 selector 指定）。');
      const src = String(found.src);
      const base = { action: 'image', tab_id: entry.handle, url: frameUrl(frame), title: frameTitle(frame), source: src.slice(0, 300), alt: found.alt, width: found.width, height: found.height };
      const inline = /^data:([^;,]+)?(;base64)?,/u.exec(src);
      if (inline !== null) {
        const comma = src.indexOf(',');
        const bytes = inline[2] === ';base64' ? src.slice(comma + 1) : btoa(unescape(encodeURIComponent(decodeURIComponent(src.slice(comma + 1)))));
        return { ...base, inline: bytes, media_type: inline[1] ?? 'image/png' };
      }
      if (src.startsWith('blob:')) {
        const drawn = await frame.executeJavaScript(`(async () => {
          const response = await fetch(${JSON.stringify(src)});
          const buffer = await response.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
          return { base64: btoa(binary), type: response.headers.get('content-type') || 'image/png' };
        })()`);
        if (typeof drawn?.base64 === 'string') return { ...base, image_url: src, inline: drawn.base64, media_type: drawn.type };
        throw new Error('无法读取 blob: 图片。');
      }
      return { ...base, image_url: src };
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
