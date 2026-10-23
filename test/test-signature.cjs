/**
 * Тест приписки в конце статьи.
 *
 *   node test-signature.cjs <путь-к-папке-расширения> [страница.html]
 *
 * Приписка («ставьте лайк, пишите, о чём рассказать дальше») — это наш собственный
 * текст, а не перевод. Проверяем в живом редакторе четыре вещи, каждая из которых
 * ломается по-своему:
 *
 *   1. текст попадает в самый конец статьи отдельным абзацем и ровно в том виде,
 *      в каком его написал пользователь (переводчик его не видел — иначе на другом
 *      языке приписка вернулась бы чужой формулировкой);
 *   2. повторное нажатие кнопки не добавляет вторую такую же приписку;
 *   3. фрагмент в середине статьи приписки не получает — она для конца статьи;
 *   4. выключенная галочка не добавляет ничего.
 *
 * Перевод подменён тождественным (@echo), поэтому единственное, что имеет право
 * измениться в статье, — сама приписка. Это и есть главная проверка.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-sign");
const USER_DATA = PATHS.testProfile("sign");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PAGE = process.argv[3] || "mock.html";
const PORT_HTTP = 8799;
const CHROME = PATHS.CHROME;

const SITE = `http://localhost:${PORT_HTTP}`;

// Текст приписки по умолчанию: проверяем орфографию. «комент», «о чем» и запятая
// перед «если» — ровно те места, где исходная формулировка была с ошибками.
const DEFAULT_SIG = "Ставьте лайк, если понравилось, и пишите в комментариях, о чём хотели бы читать больше.";
const CUSTOM_SIG = "Подписывайтесь, если было полезно: пишу о машинах каждую неделю.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
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
  const origin = `${SITE}/*`;
  m.content_scripts.forEach((cs) => {
    if (!cs.matches.includes(origin)) cs.matches.push(origin);
  });
  m.host_permissions = (m.host_permissions || []).concat([origin]);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));

  return TEST_EXT;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const file = path.join(MOCK_DIR, req.url === "/" ? PAGE : req.url.split("?")[0].replace(/^\//, ""));
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("nope");
        return;
      }
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

async function main() {
  prepareTestExtension();
  const server = await startServer();

  const chrome = spawn(
    CHROME,
    [
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--user-data-dir=" + USER_DATA,
      ...PATHS.chromeFlags(),
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

    // ---- попап как зонд настроек (chrome.runtime недоступен из главного мира)
    const probe = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    const ps = await c.send("Target.attachToTarget", { targetId: probe.targetId, flatten: true });
    await c.send("Runtime.enable", {}, ps.sessionId);
    const probeEval = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, ps.sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };
    // Попап открывается новым таргетом, и до перехода на popup.html в нём живёт
    // пустой документ: помощник, определённый раньше, теряется вместе с ним.
    for (let i = 0; i < 30; i++) {
      if (await probeEval(`!!document.getElementById('save')`)) break;
      await sleep(200);
    }
    // Ждём не появления кнопки, а применённых настроек: поля попапа заполняются
    // асинхронно, и чтение в этот промежуток даёт пустое значение.
    for (let i = 0; i < 40; i++) {
      if (await probeEval(`document.documentElement.getAttribute('data-dzr-popup') === 'ready'`)) break;
      await sleep(150);
    }
    await probeEval(
      `window.__send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, ` +
        `(r) => res(r || { ok: false, error: String(((chrome.runtime.lastError || {}).message) || "нет ответа") }))); true`
    );

    const setSettings = async (patch) => {
      const want = Object.keys(patch);
      let ok = false;
      for (let i = 0; i < 8; i++) {
        const res = await probeEval(`__send({ type: 'saveSettings', settings: ${JSON.stringify(patch)} })`);
        const raw = await probeEval(
          `__send({ type: 'getSettings' }).then((r) => JSON.stringify((r || {}).settings || {}))`
        );
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (e) {}
        if (res && res.ok && want.every((k) => parsed[k] === patch[k])) { ok = true; break; }
        await sleep(400);
      }
      if (!ok) throw new Error("не удалось применить настройки: " + JSON.stringify(patch));
    };

    const readSettings = async () =>
      JSON.parse(await probeEval(
        `__send({ type: 'getSettings' }).then((r) => JSON.stringify((r || {}).settings || {}))`
      ));

    // ---- интерфейс попапа: галочка и поле под ней
    const ui = await probeEval(`(() => {
      const box = document.getElementById('signature');
      const field = document.getElementById('signatureText');
      const wrap = document.getElementById('signature-fields');
      return {
        box: !!box,
        field: field ? { tag: field.tagName.toLowerCase(), value: field.value } : null,
        hidden: wrap ? wrap.hidden : null
      };
    })()`);
    console.log("попап: %j", { box: ui.box, tag: ui.field && ui.field.tag, hidden: ui.hidden });
    check("галочка приписки есть в настройках", ui.box === true);
    check("поле текста приписки есть", ui.field && ui.field.tag === "textarea", JSON.stringify(ui.field));
    check("по умолчанию поле скрыто (галочка снята)", ui.hidden === true, String(ui.hidden));
    check(
      "в поле подставлен текст по умолчанию",
      ui.field && ui.field.value === DEFAULT_SIG,
      JSON.stringify(ui.field && ui.field.value)
    );
    check(
      "в тексте нет «комент» и «о чем»",
      ui.field && !/комент/i.test(ui.field.value) && !/о чем/i.test(ui.field.value),
      ui.field && ui.field.value
    );

    const shown = await probeEval(`(() => {
      const box = document.getElementById('signature');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      return document.getElementById('signature-fields').hidden;
    })()`);
    check("галочка показывает поле", shown === false, String(shown));
    const hiddenAgain = await probeEval(`(() => {
      const box = document.getElementById('signature');
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      return document.getElementById('signature-fields').hidden;
    })()`);
    check("снятая галочка прячет поле", hiddenAgain === true, String(hiddenAgain));

    let sessionId = null;
    let targetId = null;

    const evalJs = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };

    const openPage = async () => {
      if (targetId) {
        try { await c.send("Target.closeTarget", { targetId }); } catch (e) {}
        await sleep(200);
      }
      const t = await c.send("Target.createTarget", { url: `${SITE}/${PAGE}` });
      targetId = t.targetId;
      const at = await c.send("Target.attachToTarget", { targetId, flatten: true });
      sessionId = at.sessionId;
      await c.send("Runtime.enable", {}, sessionId);
      await c.send("Page.enable", {}, sessionId);
      for (let i = 0; i < 60; i++) {
        if (await evalJs(`!!document.getElementById('dzr-bar') && document.documentElement.getAttribute('data-dzr-settings') === 'ready'`)) break;
        await sleep(200);
      }
      await evalJs(`document.documentElement.setAttribute("data-dzr-debug","1")`);
      await evalJs(`document.documentElement.setAttribute("data-dzr-fake-translate","@echo")`);
      return true;
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

    const toastText = () => evalJs(`(document.getElementById('dzr-toast') || {}).innerText || ''`);
    const resetToast = () => evalJs(`(() => {
      const t = document.getElementById('dzr-toast');
      if (t) { t.innerHTML = ''; t.classList.remove('dzr-show'); }
      return true;
    })()`);

    // Настоящий mouseup после программного выделения: selectionchange приходит
    // асинхронно, а страница может сбросить выделение на focusout. Без этого
    // панель иногда видит пустое выделение и отказывается работать.
    const markSelection = async () => {
      const p = await evalJs(`(() => {
        const r = document.querySelector('.body').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 20 };
      })()`);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none" }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 }, sessionId);
      await sleep(80);
    };

    const selectBody = async () => {
      const len = await evalJs(`(() => {
        const b = document.querySelector('.body');
        const r = document.createRange();
        r.selectNodeContents(b);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        return s.toString().length;
      })()`);
      await markSelection();
      return len;
    };

    /** Выделяем содержимое блока по индексу среди детей .body. */
    const selectChild = async (idx) => {
      const info = await evalJs(`(() => {
        const el = document.querySelector('.body').children[${idx}];
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        return el.tagName + ':' + s.toString().slice(0, 30);
      })()`);
      await markSelection();
      return info;
    };

    const snapshot = () =>
      evalJs(`(() => {
        const body = document.querySelector('.body');
        const kids = Array.from(body.children);
        return {
          text: body.innerText.replace(/\\s+/g, ' ').trim(),
          tags: kids.map((e) => e.tagName.toLowerCase()),
          last: kids.length ? kids[kids.length - 1].innerText.replace(/\\s+/g, ' ').trim() : '',
          lastHtml: kids.length ? kids[kids.length - 1].innerHTML : ''
        };
      })()`);

    const debugInfo = async () =>
      JSON.parse((await evalJs(`document.documentElement.getAttribute("data-dzr-debug-info")`)) || "null");

    const runTranslate = async () => {
      await resetToast();
      await clickEl("#dzr-bar .dzr-go");
      for (let i = 0; i < 50; i++) {
        const t = await toastText();
        if (/Готово|Ошибка|Не удалось/.test(t)) return t;
        await sleep(150);
      }
      return await toastText();
    };

    /** Сколько раз приписка встречается в тексте статьи. */
    const sigCount = (sig) =>
      evalJs(`(document.querySelector('.body').innerText.split(${JSON.stringify(sig)}).length - 1)`);

    // ==================== 0. значения по умолчанию ====================
    console.log("\n=== 0. настройки по умолчанию ===");
    const defaults = await readSettings();
    check("приписка по умолчанию выключена", defaults.signature === false, String(defaults.signature));
    check("текст по умолчанию сохранён в настройках", defaults.signatureText === DEFAULT_SIG, JSON.stringify(defaults.signatureText));

    // ==================== 1. приписка добавляется в конец ====================
    console.log("\n=== 1. приписка включена: статья обрабатывается целиком ===");
    await setSettings({ preview: false, signature: true, signatureText: DEFAULT_SIG });
    await openPage();
    const before = await snapshot();
    console.log("до:     теги=%j последний=%j", before.tags, before.last.slice(0, 50));
    check("в статье пока нет приписки", (await sigCount(DEFAULT_SIG)) === 0);

    await selectBody();
    let toast = await runTranslate();
    let after = await snapshot();
    let dbg = await debugInfo();
    console.log("уведомление: %j", toast.replace(/\n/g, " | "));
    console.log("после:  теги=%j последний=%j", after.tags, after.last);
    console.log("html последнего блока: %s", after.lastHtml);

    check("приписка есть в статье", (await sigCount(DEFAULT_SIG)) === 1, String(await sigCount(DEFAULT_SIG)));
    check("приписка стоит в самом конце", after.text.endsWith(DEFAULT_SIG), JSON.stringify(after.text.slice(-70)));
    check("приписка — отдельный абзац", after.tags[after.tags.length - 1] === "p", JSON.stringify(after.tags));
    check("абзац содержит только приписку", after.last === DEFAULT_SIG, JSON.stringify(after.last));
    check(
      "текст статьи перед припиской не изменился",
      after.text.slice(0, after.text.length - DEFAULT_SIG.length).trim() === before.text,
      JSON.stringify(after.text.slice(0, 60))
    );
    check("структура статьи сохранена", JSON.stringify(after.tags) === JSON.stringify(before.tags.concat(["p"])), JSON.stringify(after.tags));
    check("отладка подтверждает приписку", dbg && dbg.signature === true, dbg ? String(dbg.signature) : "нет данных; уведомление: " + toast.replace(/\n/g, " "));
    // Главное: приписка не уходила переводчику. raw — то, что реально ушло в перевод.
    check(
      "приписка не отправлялась переводчику",
      dbg && String(dbg.raw).indexOf(DEFAULT_SIG) === -1,
      dbg ? JSON.stringify(String(dbg.raw).slice(-60)) : "нет данных"
    );

    // ==================== 2. повторное нажатие ====================
    console.log("\n=== 2. кнопку нажали второй раз ===");
    await selectBody();
    await runTranslate();
    after = await snapshot();
    console.log("после:  теги=%j", after.tags);
    check("вторая приписка не добавилась", (await sigCount(DEFAULT_SIG)) === 1, String(await sigCount(DEFAULT_SIG)));
    check("структура статьи не поехала", JSON.stringify(after.tags) === JSON.stringify(before.tags.concat(["p"])), JSON.stringify(after.tags));

    // ==================== 3. фрагмент в середине ====================
    console.log("\n=== 3. выделен первый блок (заголовок) ===");
    await openPage();
    const mid = await snapshot();
    const selected = await selectChild(0);
    toast = await runTranslate();
    after = await snapshot();
    dbg = await debugInfo();
    console.log("выделено: %j", selected);
    console.log("уведомление: %j", toast.replace(/\n/g, " | "));
    console.log("после:  теги=%j", after.tags);
    check("приписки не появилось", (await sigCount(DEFAULT_SIG)) === 0, String(await sigCount(DEFAULT_SIG)));
    check("отладка подтверждает отказ", dbg && dbg.signature === false, dbg ? String(dbg.signature) : "нет данных; уведомление: " + toast.replace(/\n/g, " "));
    check("остальная статья не тронута", after.text === mid.text, JSON.stringify(after.text.slice(0, 60)));

    // ==================== 4. свой текст приписки ====================
    console.log("\n=== 4. текст приписки заменён в настройках ===");
    await setSettings({ signatureText: CUSTOM_SIG });
    await openPage();
    const customBefore = await snapshot();
    await selectBody();
    await runTranslate();
    after = await snapshot();
    console.log("после:  последний=%j", after.last);
    check("добавлен свой текст", (await sigCount(CUSTOM_SIG)) === 1, String(await sigCount(CUSTOM_SIG)));
    check("прежний текст не добавлен", (await sigCount(DEFAULT_SIG)) === 0);
    check("свой текст стоит в конце", after.text.endsWith(CUSTOM_SIG), JSON.stringify(after.text.slice(-60)));
    check("текст статьи перед припиской цел", after.text.slice(0, after.text.length - CUSTOM_SIG.length).trim() === customBefore.text);

    // ==================== 5. выключенная галочка ====================
    console.log("\n=== 5. галочка снята ===");
    await setSettings({ signature: false });
    await openPage();
    const offBefore = await snapshot();
    await selectBody();
    await runTranslate();
    after = await snapshot();
    dbg = await debugInfo();
    console.log("после:  теги=%j", after.tags);
    check("приписки нет", (await sigCount(CUSTOM_SIG)) === 0 && (await sigCount(DEFAULT_SIG)) === 0);
    check("статья не изменилась", after.text === offBefore.text, JSON.stringify(after.text.slice(0, 60)));
    check("отладка подтверждает отказ", dbg && dbg.signature === false, dbg ? String(dbg.signature) : "нет данных; уведомление: " + toast.replace(/\n/g, " "));

    // ==================== 6. последний абзац выделен частично ====================
    // Здесь работает другая ветка вставки — замена внутри одного блока. Приписка
    // обязана остаться текстом, а не сломать абзац вложенным <p>.
    console.log("\n=== 6. выделен последний абзац целиком (ветка «внутри блока») ===");
    await setSettings({ signature: true, signatureText: DEFAULT_SIG });
    await openPage();
    const lastIdx = (await snapshot()).tags.length - 1;
    await selectChild(lastIdx);
    await runTranslate();
    after = await snapshot();
    console.log("после:  последний=%j", after.last.slice(-70));
    console.log("html последнего блока: %s", after.lastHtml);
    check("приписка добавлена", (await sigCount(DEFAULT_SIG)) === 1, String(await sigCount(DEFAULT_SIG)));
    check("абзац не развалился на два", after.tags[after.tags.length - 1] === "p", JSON.stringify(after.tags));
    check("в абзаце нет вложенного <p>", !/<p[\s>]/i.test(after.lastHtml), String(after.lastHtml).slice(0, 120));
    check("текст абзаца заканчивается припиской", after.last.endsWith(DEFAULT_SIG), JSON.stringify(after.last.slice(-60)));

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (errs.length) {
      console.log("\nисключения:");
      errs.slice(-6).forEach((e) => console.log("  ", JSON.stringify(e.params).slice(0, 300)));
    }
    check("в странице нет исключений", errs.length === 0, errs.length + " шт.");

    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const p = path.join(TMP, "shot-signature.png");
    fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
    console.log("\nскриншот: %s", p);

    console.log("\n=== ИТОГ ===");
    const bad = results.filter((r) => !r.ok);
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
    bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
    process.exitCode = bad.length ? 1 : 0;
  } finally {
    try { server.close(); } catch (e) {}
    try { execSync("taskkill /F /T /PID " + chrome.pid, { stdio: "ignore" }); } catch (e) {}
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e.message || e); process.exit(1); });
