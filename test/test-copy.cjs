/**
 * Тест уведомления: клик по нему копирует результат.
 *
 *   node test-copy.cjs <путь-к-папке-расширения> [страница.html]
 *
 * Проверяем три вещи:
 *  1. Уведомление с результатом кликабельно и объясняет это подсказкой,
 *     а уведомление без результата (ошибка, «ничего не выделено») — нет.
 *  2. Клик действительно кладёт в буфер результат: сначала пробуем отдать
 *     HTML и текст сразу, при отказе — только текст, при полном запрете
 *     показываем ошибку, а не молчим.
 *  3. Один и тот же результат попадает в системный буфер (читаем его обратно
 *     настоящим clipboard.read), а не только в подставной объект.
 *
 * Перевод подменяем через data-dzr-fake-translate="@echo": результат обязан
 * совпасть с исходным текстом, поэтому ожидание считается независимо.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const ROOT = PATHS.REPO;
const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-copy");
const USER_DATA = PATHS.testProfile("copy");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PAGE = process.argv[3] || "mock.html";
const PORT_HTTP = 8795;
const CHROME = PATHS.CHROME;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}
function note(text) {
  console.log("  · " + text);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function prepareTestExtension() {
  copyDir(SRC_EXT, TEST_EXT);
  const mf = path.join(TEST_EXT, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  const origin = `http://localhost:${PORT_HTTP}/*`;
  m.content_scripts.forEach((cs) => { if (!cs.matches.includes(origin)) cs.matches.push(origin); });
  m.host_permissions = (m.host_permissions || []).concat([origin]);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  return TEST_EXT;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const file = path.join(MOCK_DIR, req.url === "/" ? "mock.html" : req.url.split("?")[0]);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("nope"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(PORT_HTTP, "127.0.0.1", () => r(server)));
}

function pipeCdp(child) {
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  let buf = "";
  let id = 0;
  const pending = new Map();
  const events = [];

  fromBrowser.setEncoding("utf8");
  fromBrowser.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!raw.trim()) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) events.push(msg);
    }
  });

  return {
    events,
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        const payload = sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params };
        toBrowser.write(JSON.stringify(payload) + "\0");
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); }
        }, 20000);
      })
  };
}

function killChrome(child) {
  if (!child) return;
  try { execSync("taskkill /F /T /PID " + child.pid, { stdio: "ignore" }); } catch (e) {}
}

async function main() {
  prepareTestExtension();
  const server = await startServer();

  const chrome = spawn(
    CHROME,
    [
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--user-data-dir=" + USER_DATA,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1280,900",
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
  );

  const c = pipeCdp(chrome);
  try {
    let extId = null;
    for (let i = 0; i < 40; i++) {
      try { const r = await c.send("Extensions.loadUnpacked", { path: TEST_EXT }); extId = r.id; break; }
      catch (e) { if (i === 39) throw e; await sleep(400); }
    }
    await PATHS.clearStorage(c, extId, TEST_EXT);
    console.log("расширение: %s", extId);

    // Клипуем права на буфер для origin мока: без них не прочитать, что реально
    // попало в системный буфер обмена (запись работает и по жесту пользователя).
    try {
      await c.send("Browser.grantPermissions", {
        origin: `http://localhost:${PORT_HTTP}`,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"]
      });
      note("права на буфер обмена выданы для http://localhost:" + PORT_HTTP);
    } catch (e) {
      note("не удалось выдать права на буфер: " + (e.message || e));
    }

    // Предпросмотр выключаем: нужен сразу вставленный текст и уведомление о нём.
    // Пишем через штатный saveSettings и проверяем прочитанное — запись может
    // гоняться с onInstalled при первой загрузке расширения.
    {
      const pv = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
      const s2 = await c.send("Target.attachToTarget", { targetId: pv.targetId, flatten: true });
      await c.send("Runtime.enable", {}, s2.sessionId);
      const ev = async (expression) => {
        const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, s2.sessionId);
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
      };
      // Попап открывается в новом таргете, и сначала в нём живёт пустой документ:
      // помощник, определённый до перехода на popup.html, теряется вместе с ним.
      for (let i = 0; i < 30; i++) {
        if (await ev(`!!document.getElementById('save')`)) break;
        await sleep(200);
      }
      await ev(
        `window.__send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, ` +
          `(r) => res(r || { ok: false, error: String(((chrome.runtime.lastError || {}).message) || "нет ответа") }))); true`
      );
      let ok = false;
      for (let i = 0; i < 8; i++) {
        const res = await ev(`__send({ type: 'saveSettings', settings: { preview: false } })`);
        const raw = await ev(`__send({ type: 'getSettings' }).then((r) => JSON.stringify((r || {}).settings || {}))`);
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (e) {}
        if (res && res.ok && parsed.preview === false) { ok = true; break; }
        await sleep(400);
      }
      if (!ok) throw new Error("не удалось выключить предпросмотр для теста");
      await c.send("Target.closeTarget", { targetId: pv.targetId });
    }

    const { targetId } = await c.send("Target.createTarget", { url: `http://localhost:${PORT_HTTP}/${PAGE}` });
    const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
    await c.send("Runtime.enable", {}, sessionId);
    await c.send("Page.enable", {}, sessionId);
    // clipboard.readText() отвечает «Document is not focused», если вкладка не в
    // фокусе, а окно Chrome под управлением CDP фокус не гарантирует. Эмуляция
    // фокуса делает чтение буфера предсказуемым.
    try {
      await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
    } catch (e) {
      note("эмуляция фокуса недоступна: " + (e.message || e));
    }
    try { await c.send("Page.bringToFront", {}, sessionId); } catch (e) {}

    // страница (основной мир): отсюда кликаем и читаем системный буфер
    const evalJs = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };

    for (let i = 0; i < 40; i++) {
      if (await evalJs(`!!document.getElementById('dzr-bar') && document.documentElement.getAttribute('data-dzr-settings') === 'ready'`)) break;
      await sleep(250);
    }
    await evalJs(`document.documentElement.setAttribute("data-dzr-fake-translate","@echo")`);

    // --- контекст контент-скрипта -------------------------------------------
    // Контент-скрипт живёт в изолированном мире: у него СВОЙ navigator, и подмена
    // navigator.clipboard из основного мира на него не влияет. Чтобы проверить
    // запасные пути копирования, надо писать в тот же мир, что и код.
    let contentCtx = null;
    for (let i = 0; i < 20; i++) {
      const created = c.events.filter((e) => e.method === "Runtime.executionContextCreated");
      const iso = created
        .map((e) => e.params.context)
        .filter((ctx) => ctx.auxData && ctx.auxData.type === "isolated" && ctx.auxData.frameId === targetId);
      if (iso.length) { contentCtx = iso[iso.length - 1].id; break; }
      await sleep(200);
    }
    if (contentCtx == null) {
      const all = c.events.filter((e) => e.method === "Runtime.executionContextCreated")
        .map((e) => e.params.context)
        .filter((ctx) => ctx.auxData && ctx.auxData.type === "isolated");
      note("изолированные контексты: " + JSON.stringify(all.map((x) => ({ id: x.id, name: x.name }))));
      if (!all.length) throw new Error("не нашёл контекст контент-скрипта");
      contentCtx = all[all.length - 1].id;
    }
    note("контекст контент-скрипта: id=" + contentCtx);

    const evalExt = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, contextId: contentCtx, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };

    const clickEl = async (selector) => {
      const rect = await evalJs(`(() => {
        const b = document.querySelector(${JSON.stringify(selector)});
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!rect) throw new Error("нет элемента " + selector);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
    };

    const toastState = () => evalJs(`(() => {
      const t = document.getElementById('dzr-toast');
      if (!t) return null;
      const hint = t.querySelector('.dzr-toast-hint');
      const cs = getComputedStyle(t);
      return {
        text: t.innerText,
        shown: t.classList.contains('dzr-show'),
        copyable: t.classList.contains('dzr-copyable'),
        pointerEvents: cs.pointerEvents,
        cursor: cs.cursor,
        role: t.getAttribute('role'),
        tabindex: t.getAttribute('tabindex'),
        title: t.getAttribute('title'),
        hint: hint ? hint.textContent : null,
        hintClass: hint ? hint.className : null
      };
    })()`);

    const toastText = () => evalJs(`(document.getElementById('dzr-toast') || {}).innerText || ''`);

    const saveShot = async (name) => {
      const s = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
      const p = path.join(TMP, "shot-copy-" + name + ".png");
      fs.writeFileSync(p, Buffer.from(s.data, "base64"));
      return p;
    };

    // Ожидание считаем из DOM до обработки — независимо от внутренностей расширения.
    const EXPECTED = await evalJs(`document.querySelector('.body p').innerText.replace(/\\s+/g, ' ').trim()`);
    note("ожидаемый текст: " + JSON.stringify(EXPECTED.slice(0, 70)) + "…");

    // Уведомление одно на все сообщения, поэтому «дождаться нового» по тексту
    // нельзя: предыдущее тоже содержит «Готово», и ожидание вернётся сразу,
    // не дождавшись прогона. Сначала чистим уведомление — тогда появление
    // текста означает именно новое сообщение.
    const resetToast = () => evalJs(`(() => {
      const t = document.getElementById('dzr-toast');
      if (t) { t.innerHTML = ''; t.classList.remove('dzr-show'); }
      return true;
    })()`);

    const runAndWaitToast = async () => {
      await resetToast();
      await evalJs(`(() => {
        const p = document.querySelector('.body p');
        const r = document.createRange();
        r.selectNodeContents(p);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(r);
      })()`);
      await clickEl("#dzr-bar .dzr-go");
      for (let i = 0; i < 40; i++) {
        const t = await toastText();
        if (/Готово/.test(t)) return true;
        await sleep(150);
      }
      return false;
    };

    // ============================ 1. уведомление кликабельно ============================
    console.log("\n=== уведомление с результатом ===");
    if (!(await runAndWaitToast())) throw new Error("не дождался уведомления «Готово»");

    let st = await toastState();
    console.log("  уведомление: %j", st);
    check("уведомление показано", st && st.shown === true);
    check("уведомление помечено кликабельным", st.copyable === true);
    check("клики по нему не проходят сквозь", st.pointerEvents === "auto", st.pointerEvents);
    check("курсор — указатель", st.cursor === "pointer", st.cursor);
    check("доступно с клавиатуры", st.role === "button" && st.tabindex === "0", st.role + "/" + st.tabindex);
    check("есть подсказка про копирование", /скопировать/i.test(st.hint || ""), st.hint);
    check("подсказка в отдельном элементе", /dzr-toast-hint/.test(st.hintClass || ""), st.hintClass);
    check("в тексте уведомления есть статистика", /Готово/.test(st.text) && /уникальность/.test(st.text));
    console.log("  скриншот кликабельного уведомления: %s", await saveShot("clickable"));

    // ==================== 2. отказ от HTML → копируем текстом ====================
    console.log("\n=== запасной путь: только текст ===");
    await evalExt(`(() => {
      window.__cap = { calls: [] };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write: () => { window.__cap.calls.push('write'); return Promise.reject(new Error('нет ClipboardItem')); },
          writeText: (t) => { window.__cap.calls.push('writeText'); window.__cap.text = t; return Promise.resolve(); }
        }
      });
      return true;
    })()`);
    await clickEl("#dzr-toast");
    await sleep(500);
    st = await toastState();
    const cap = await evalExt(`window.__cap`);
    console.log("  вызовы: %j, текст: %j", cap.calls, String(cap.text || "").slice(0, 60));
    check("сначала попробовали богатое копирование", cap.calls[0] === "write", JSON.stringify(cap.calls));
    check("при отказе перешли на writeText", cap.calls.indexOf("writeText") > -1, JSON.stringify(cap.calls));
    check("текст для буфера — ровно результат", cap.text === EXPECTED, JSON.stringify(String(cap.text || "").slice(0, 70)));
    check("подсказка подтвердила копирование", /📋 Скопировано/.test(st.hint || ""), st.hint);
    check("подсказка помечена успехом", /dzr-toast-hint-ok/.test(st.hintClass || ""), st.hintClass);

    // ==================== 3. копирование запрещено совсем ====================
    console.log("\n=== буфер недоступен ===");
    if (!(await runAndWaitToast())) throw new Error("не дождался второго уведомления");
    await evalExt(`(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write: () => Promise.reject(new Error('запрещено')),
          writeText: () => Promise.reject(new Error('запрещено'))
        }
      });
      document.execCommand = () => false;
      return true;
    })()`);
    await clickEl("#dzr-toast");
    await sleep(500);
    st = await toastState();
    console.log("  подсказка: %j", st.hint);
    check("о неудаче сообщили, а не промолчали", /Не удалось скопировать/.test(st.hint || ""), st.hint);
    check("подсказка помечена ошибкой", /dzr-toast-hint-err/.test(st.hintClass || ""), st.hintClass);

    // ==================== 4. настоящий буфер обмена ====================
    console.log("\n=== системный буфер обмена ===");
    // снимаем подставной clipboard: удаление своего свойства возвращает родной getter
    await evalExt(`(() => {
      delete navigator.clipboard;
      delete document.execCommand;
      return typeof (navigator.clipboard && navigator.clipboard.write);
    })()`);
    if (!(await runAndWaitToast())) throw new Error("не дождался третьего уведомления");
    await clickEl("#dzr-toast");
    await sleep(700);
    st = await toastState();
    console.log("  подсказка: %j", st.hint);

    const real = await evalJs(`(async () => {
      const out = { readText: null, err: null, types: null, html: null };
      try { out.readText = await navigator.clipboard.readText(); } catch (e) { out.err = String(e && e.message || e); }
      try {
        const items = await navigator.clipboard.read();
        out.types = items[0] ? items[0].types : null;
        if (items[0] && items[0].types.indexOf('text/html') > -1) {
          out.html = await (await items[0].getType('text/html')).text();
        }
      } catch (e) { if (!out.err) out.err = String(e && e.message || e); }
      return out;
    })()`);
    console.log("  буфер: %j", { readText: String(real.readText || "").slice(0, 60), types: real.types, err: real.err });
    check("в системный буфер попал результат", real.readText === EXPECTED, JSON.stringify(String(real.readText || "").slice(0, 70)));
    check("в буфере есть и HTML-представление", Array.isArray(real.types) && real.types.indexOf("text/html") > -1, JSON.stringify(real.types));
    check("HTML содержит текст абзаца", typeof real.html === "string" && real.html.indexOf(EXPECTED.slice(0, 40)) > -1, JSON.stringify(String(real.html || "").slice(0, 70)));
    check("выбран богатый путь копирования", /с форматированием/.test(st.hint || ""), st.hint);
    console.log("  скриншот подтверждения: %s", await saveShot("copied"));

    // ==================== 5. с клавиатуры ====================
    console.log("\n=== копирование с клавиатуры ===");
    await evalJs(`(() => { document.getElementById('dzr-toast').focus(); return document.activeElement.id; })()`);
    await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    await sleep(600);
    st = await toastState();
    check("Enter на уведомлении тоже копирует", /📋 Скопировано/.test(st.hint || ""), st.hint);

    // ==================== 6. обычное уведомление не кликабельно ====================
    console.log("\n=== уведомление без результата ===");
    await evalJs(`(() => { const s = window.getSelection(); s.removeAllRanges(); })()`);
    await clickEl("#dzr-bar .dzr-go");
    for (let i = 0; i < 30; i++) {
      const t = await toastText();
      if (/Ничего не выделено|Вся статья/.test(t)) break;
      await sleep(150);
    }
    st = await toastState();
    console.log("  уведомление: %j", { text: String(st.text).slice(0, 50), copyable: st.copyable, pointerEvents: st.pointerEvents });
    check("уведомление без результата не кликабельно", st.copyable === false, String(st.copyable));
    check("клики проходят сквозь него", st.pointerEvents === "none", st.pointerEvents);
    check("нет подсказки про копирование", st.hint === null, String(st.hint));
    check("нет роли кнопки", st.role === null && st.tabindex === null, st.role + "/" + st.tabindex);

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (errs.length) {
      console.log("\nисключения:");
      errs.slice(-6).forEach((e) => console.log("  ", JSON.stringify(e.params).slice(0, 300)));
    }
    check("в странице нет исключений", errs.length === 0, errs.length + " шт.");

    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const p = path.join(TMP, "shot-copy.png");
    fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
    console.log("\nскриншот: %s", p);

    console.log("\n=== ИТОГ ===");
    const bad = results.filter((r) => !r.ok);
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
    bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
  } finally {
    try { server.close(); } catch (e) {}
    killChrome(chrome);
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e.message || e); process.exit(1); });
