// MCP Browser Bridge: background script.
// Keeps a WebSocket open to the local MCP server and runs the commands it sends.

const PORT = 8765; // must match FIREFOX_MCP_PORT on the server (default 8765)
const RETRY_MS = 2000;

let ws = null;

function setStatus(connected) {
  browser.browserAction.setBadgeText({ text: connected ? "on" : "" });
  browser.browserAction.setBadgeBackgroundColor({ color: "#2e7d32" });
  browser.browserAction.setTitle({
    title: "MCP Browser Bridge: " + (connected ? "connected" : "not connected"),
  });
}

function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.onopen = () => setStatus(true);
  ws.onclose = () => {
    setStatus(false);
    setTimeout(connect, RETRY_MS);
  };
  ws.onerror = () => {}; // onclose follows and schedules the retry
  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const reply = { id: msg.id };
    try {
      const handler = handlers[msg.method];
      if (!handler) throw new Error(`Unknown method: ${msg.method}`);
      reply.result = await handler(msg.params || {});
    } catch (err) {
      reply.error = String((err && err.message) || err);
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  };
}

// ---------- helpers ----------

async function resolveTabId(tabId) {
  if (typeof tabId === "number") return tabId;
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab.id;
}

function tabInfo(t) {
  return { tabId: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url, status: t.status };
}

function waitForLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs.get(tabId).then((t) => t.status === "complete" && done(), done);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs fn(arg) inside the page's content-script sandbox and returns its result.
async function inPage(tabId, fn, arg) {
  const code = `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`;
  const [result] = await browser.tabs.executeScript(tabId, { code, runAt: "document_idle" });
  if (result && result.__error) throw new Error(result.__error);
  return result;
}

// If an action started a navigation, wait for it to finish.
async function settle(tabId) {
  await sleep(400);
  const t = await browser.tabs.get(tabId);
  if (t.status !== "complete") await waitForLoad(tabId);
  return tabInfo(await browser.tabs.get(tabId));
}

// ---------- functions injected into pages ----------

function pageText(maxChars) {
  const root = document.querySelector("article, main, [role=main]") || document.body;
  let text = (root ? root.innerText : "") || "";
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  const truncated = text.length > maxChars;
  return { url: location.href, title: document.title, truncated, text: text.slice(0, maxChars) };
}

function pageSnapshot(maxElements) {
  const SELECTOR =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],' +
    "[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch]," +
    '[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const all = Array.from(document.querySelectorAll(SELECTOR));
  let next = all.reduce((m, el) => Math.max(m, Number(el.getAttribute("data-mcp-ref")) || 0), 0) + 1;
  const lines = [];
  let skipped = 0;
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none") continue;
    if (lines.length >= maxElements) {
      skipped++;
      continue;
    }
    if (!el.hasAttribute("data-mcp-ref")) el.setAttribute("data-mcp-ref", String(next++));
    const ref = el.getAttribute("data-mcp-ref");
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    let kind = role || tag;
    if (tag === "input") kind = `input[${el.type}]`;
    if (tag === "a") kind = "link";
    const label = clean(
      el.getAttribute("aria-label") ||
        (el.labels && el.labels[0] && el.labels[0].innerText) ||
        el.innerText ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        el.getAttribute("name")
    );
    let extra = "";
    if (tag === "a") extra += ` -> ${el.href.slice(0, 120)}`;
    if ((tag === "input" || tag === "textarea") && el.type !== "password" && el.value) extra += ` value="${clean(el.value)}"`;
    if (tag === "select") extra += ` selected="${clean(el.selectedOptions[0] && el.selectedOptions[0].text)}"`;
    if (el.type === "checkbox" || el.type === "radio") extra += el.checked ? " (checked)" : " (unchecked)";
    if (el.disabled) extra += " (disabled)";
    const inView = r.bottom > 0 && r.top < innerHeight ? "" : " (offscreen)";
    lines.push(`[${ref}] ${kind} "${label}"${extra}${inView}`);
  }
  return {
    url: location.href,
    title: document.title,
    scroll: `${Math.round(scrollY)} of ${Math.max(0, document.documentElement.scrollHeight - innerHeight)}px`,
    elements: lines.join("\n") + (skipped ? `\n... ${skipped} more elements not listed` : ""),
  };
}

function pageAct(p) {
  try {
    let el = null;
    if (p.ref != null) el = document.querySelector(`[data-mcp-ref="${CSS.escape(String(p.ref))}"]`);
    else if (p.selector) el = document.querySelector(p.selector);
    if (p.action === "scroll" && !el) {
      const amount = p.amount || Math.round(innerHeight * 0.8);
      scrollBy({ top: p.direction === "up" ? -amount : amount });
      return { ok: true, scrollY: Math.round(scrollY) };
    }
    if (!el) return { __error: "Element not found. Call read_page again to get fresh refs." };
    el.scrollIntoView({ block: "center", inline: "center" });
    if (p.action === "scroll") return { ok: true };

    if (p.action === "click") {
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.click();
      return { ok: true };
    }

    if (p.action === "type") {
      const tag = el.tagName.toLowerCase();
      el.focus();
      if (tag === "select") {
        const want = String(p.text).toLowerCase();
        const opt = Array.from(el.options).find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want);
        if (!opt) return { __error: "No option matches. Options: " + Array.from(el.options).map((o) => o.text.trim()).join(" | ") };
        el.value = opt.value;
      } else if (tag === "input" || tag === "textarea") {
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el, p.append ? el.value + p.text : p.text); // native setter so React-style frameworks notice
      } else if (el.isContentEditable) {
        if (!p.append) document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, p.text);
      } else {
        return { __error: `Can't type into a <${tag}> element` };
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (p.submit) {
        const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const proceed = el.dispatchEvent(new KeyboardEvent("keydown", key));
        el.dispatchEvent(new KeyboardEvent("keyup", key));
        if (proceed && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      }
      return { ok: true };
    }
    return { __error: `Unknown action: ${p.action}` };
  } catch (e) {
    return { __error: String(e.message || e) };
  }
}

// ---------- command handlers ----------

const handlers = {
  async ping() {
    return { ok: true, browser: (await browser.runtime.getBrowserInfo()).version };
  },

  async tabs_list() {
    return (await browser.tabs.query({})).map(tabInfo);
  },

  async tab_create({ url, background }) {
    const tab = await browser.tabs.create({ url: url || "about:blank", active: !background });
    if (url) await waitForLoad(tab.id);
    return tabInfo(await browser.tabs.get(tab.id));
  },

  async tab_close({ tabId }) {
    await browser.tabs.remove(tabId);
    return { ok: true };
  },

  async tab_activate({ tabId }) {
    const tab = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return tabInfo(tab);
  },

  async navigate({ tabId, url }) {
    const id = await resolveTabId(tabId);
    if (url === "back") await browser.tabs.goBack(id);
    else if (url === "forward") await browser.tabs.goForward(id);
    else if (url === "reload") await browser.tabs.reload(id);
    else await browser.tabs.update(id, { url: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : "https://" + url });
    await sleep(150);
    await waitForLoad(id);
    return tabInfo(await browser.tabs.get(id));
  },

  async get_page_text({ tabId, maxChars }) {
    return inPage(await resolveTabId(tabId), pageText, maxChars || 50000);
  },

  async read_page({ tabId, maxElements }) {
    return inPage(await resolveTabId(tabId), pageSnapshot, maxElements || 300);
  },

  async click({ tabId, ref, selector }) {
    const id = await resolveTabId(tabId);
    await inPage(id, pageAct, { action: "click", ref, selector });
    return settle(id);
  },

  async type({ tabId, ref, selector, text, append, submit }) {
    const id = await resolveTabId(tabId);
    await inPage(id, pageAct, { action: "type", ref, selector, text, append, submit });
    return submit ? settle(id) : { ok: true };
  },

  async scroll({ tabId, ref, direction, amount }) {
    return inPage(await resolveTabId(tabId), pageAct, { action: "scroll", ref, direction, amount });
  },

  async screenshot({ tabId }) {
    const id = await resolveTabId(tabId);
    const dataUrl = await browser.tabs.captureTab(id, { format: "jpeg", quality: 70 });
    return { mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  },

  async run_javascript({ tabId, code }) {
    const id = await resolveTabId(tabId);
    const wrapped = `(async () => { try { const v = await (async () => { ${code}\n })(); return { value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }; } catch (e) { return { __error: String(e && e.message || e) }; } })()`;
    const [result] = await browser.tabs.executeScript(id, { code: wrapped });
    if (result && result.__error) throw new Error(result.__error);
    return result;
  },
};

connect();
