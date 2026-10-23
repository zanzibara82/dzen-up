/**
 * Тест чистки ссылок при переводе.
 *
 *   node test-strip.cjs <путь-к-папке-расширения> [страница.html]
 *
 * Статья, скопированная с чужого сайта, приезжает вместе со ссылками. Расширение
 * обязано снять их до перевода, а текст ссылки оставить на месте — иначе фраза
 * рассыпается. Здесь проверяем весь путь в живом редакторе: выделение → разбор
 * блоков → «перевод» → вставка.
 *
 * Перевод подменён каналом data-dzr-fake-translate="@echo" — он возвращает текст
 * как есть. Так проверка не зависит от сети и, что важнее, строгая: результат
 * обязан совпасть с оригиналом ВЕЗДЕ, кроме ссылок. Любая другая потеря сразу
 * видна как расхождение текста.
 *
 * Мок (mock-strip.html) нарочно содержит восемь ссылок, и каждая идёт своим
 * путём: обычный текст, жирный внутри ссылки, картинка внутри ссылки, подпись
 * к картинке, пункт списка, ячейка таблицы, абзац целиком из ссылки, заголовок.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-strip");
const USER_DATA = PATHS.testProfile("strip");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PAGE = process.argv[3] || "mock-strip.html";
const PORT_HTTP = 8798;
const CHROME = PATHS.CHROME;

const SITE = `http://localhost:${PORT_HTTP}`;

// Ссылки мока в порядке появления в документе — эталон для режима «не трогать».
const HREFS = [
  "https://example.com/h2",
  "https://www.subaru.com/",
  "https://example.com/parts",
  "https://example.com/photo",
  "https://example.com/credits",
  "https://example.com/clearance",
  "https://example.com/trim",
  "https://example.com/also"
];
const LINK_COUNT = HREFS.length;

// Текст, который существует только внутри ссылок: в режиме «вместе с текстом»
// он обязан исчезнуть, в остальных — остаться.
const LINK_ONLY = [
  "what changed",
  "the official page",
  "full parts list",
  "press service",
  "9.5 inches",
  "Wilderness",
  "Читайте также"
];
// Текст вне ссылок — не должен пострадать ни в одном режиме.
const KEEP_TEXT = [
  "2.4-liter Boxer engine",
  "the towing capacity is",
  "3,500 lbs",
  "Ground clearance is",
  "Trim"
];

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
    // Попап открывается в новом таргете, и сначала в нём живёт пустой документ:
    // помощник, определённый до перехода на popup.html, теряется вместе с ним.
    for (let i = 0; i < 30; i++) {
      if (await probeEval(`!!document.getElementById('save')`)) break;
      await sleep(200);
    }
    await probeEval(
      `window.__send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, ` +
        `(r) => res(r || { ok: false, error: String(((chrome.runtime.lastError || {}).message) || "нет ответа") }))); true`
    );

    // Настройку пишем штатным saveSettings, а не напрямую в storage: иначе тест
    // проверял бы не тот путь, которым пользуется попап. И обязательно читаем
    // обратно — запись гоняется с onInstalled.
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

    // Проверяем значение по умолчанию до всего остального: пользователь, который
    // ничего не настраивал, обязан получить чистку ссылок «из коробки».
    const defaults = JSON.parse(await probeEval(
      `__send({ type: 'getSettings' }).then((r) => JSON.stringify((r || {}).settings || {}))`
    ));
    console.log("настройки по умолчанию: stripLinks=%j", defaults.stripLinks);

    let sessionId = null;
    let targetId = null;

    const evalJs = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };

    // Страницу открываем заново, а не перезагружаем: после location.reload()
    // синтетические клики по CDP доходят через раз, а новая вкладка даёт свежий
    // input-таргет. Заодно content-скрипт заново читает настройки.
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
      // Ждём не «панель появилась», а «настройки применены»: loadSettings
      // асинхронный, и клик в это окно отработал бы по значениям из S.
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

    /** Выделяем весь текст статьи. */
    const selectBody = () =>
      evalJs(`(() => {
        const b = document.querySelector('.body');
        const r = document.createRange();
        r.selectNodeContents(b);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        return s.toString().length;
      })()`);

    /** Выделяем содержимое одного абзаца (путь «только этот блок»). */
    const selectParagraph = (idx) =>
      evalJs(`(() => {
        const ps = document.querySelectorAll('.body p');
        const r = document.createRange();
        r.selectNodeContents(ps[${idx}]);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        return s.toString().slice(0, 40);
      })()`);

    /** Снимок статьи: ссылки, разметка и текст без разметки. */
    const snapshot = () =>
      evalJs(`(() => {
        const body = document.querySelector('.body');
        return {
          links: Array.from(body.querySelectorAll('a')).map((a) => a.getAttribute('href')),
          linkText: Array.from(body.querySelectorAll('a')).map((a) => a.textContent.trim()),
          html: body.innerHTML,
          text: body.innerText.replace(/\\s+/g, ' ').trim(),
          imgs: body.querySelectorAll('img').length,
          strong: body.querySelectorAll('strong').length,
          figures: body.querySelectorAll('figure').length,
          figcaption: body.querySelectorAll('figcaption').length,
          tables: body.querySelectorAll('table').length,
          tags: Array.from(body.children).map((e) => e.tagName.toLowerCase())
        };
      })()`);

    const debugInfo = async () => JSON.parse((await evalJs(`document.documentElement.getAttribute("data-dzr-debug-info")`)) || "null");

    /** Жмёт «перевести» и ждёт уведомления. */
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

    // ==================== 0. значение по умолчанию ====================
    console.log("\n=== 0. настройка по умолчанию ===");
    check("ссылки чистятся из коробки", defaults.stripLinks === "keep", String(defaults.stripLinks));

    // ==================== 1. «убрать ссылку, текст оставить» ====================
    console.log("\n=== 1. режим keep: ссылки сняты, текст цел ===");
    await setSettings({ preview: false, stripLinks: "keep" });
    await openPage();
    const before = await snapshot();
    console.log("до:     ссылок=%d img=%d strong=%d figure=%d figcaption=%d table=%d", before.links.length, before.imgs, before.strong, before.figures, before.figcaption, before.tables);
    check("в моке ровно " + LINK_COUNT + " ссылок", before.links.length === LINK_COUNT, String(before.links.length));

    await selectBody();
    let toast = await runTranslate();
    let after = await snapshot();
    let dbg = await debugInfo();
    console.log("уведомление: %j", toast.replace(/\n/g, " | "));
    console.log("после:  ссылок=%d img=%d strong=%d figure=%d figcaption=%d table=%d", after.links.length, after.imgs, after.strong, after.figures, after.figcaption, after.tables);
    console.log("html:   %s", String(after.html).slice(0, 300));

    check("ссылок в статье не осталось", after.links.length === 0, JSON.stringify(after.links));
    check("текст ссылок остался на месте", LINK_ONLY.every((s) => after.text.includes(s)), LINK_ONLY.filter((s) => !after.text.includes(s)).join(", "));
    check("остальной текст не пострадал", KEEP_TEXT.every((s) => after.text.includes(s)));
    check("текст статьи совпал с оригиналом слово в слово", after.text === before.text, JSON.stringify(after.text.slice(0, 90)));
    check("картинка сохранена", after.imgs === before.imgs && after.imgs === 1, "img=" + after.imgs);
    check("жирный сохранён", after.strong === before.strong && after.strong >= 1, "strong=" + after.strong);
    // Подпись содержит два текстовых узла («Photo: » и «press service»), и раньше
    // каждый нёс свою копию обёртки: подпись распадалась на два <figcaption>.
    // Теперь соседи с общим предком склеиваются, и подпись остаётся одной.
    check("фигура сохранена", after.figures === 1, "figure=" + after.figures);
    check("подпись — ровно один <figcaption>", after.figcaption === 1, "figcaption=" + after.figcaption);
    check("текст подписи цел и лежит в одной подписи",
      (await evalJs(`(document.querySelector('.body figcaption')||{}).innerText||''`)).replace(/\s+/g, " ").trim() === "Photo: press service",
      JSON.stringify(await evalJs(`(document.querySelector('.body figcaption')||{}).innerText||''`)));
    check("таблица сохранена", after.tables === 1, "table=" + after.tables);
    check("структура блоков не изменилась", JSON.stringify(after.tags) === JSON.stringify(before.tags), JSON.stringify(after.tags));
    check("маркеры не попали в текст", !/\[\[|\]\]/.test(after.html), String(after.html).match(/\[\[[^\]]*\]\]/g));
    // Склейка общих предков не должна втягивать пробел внутрь соседней обёртки:
    // «<strong>red</strong> <em>blue</em>» — это два разных элемента, а не один.
    {
      const around = (String(after.html).match(/<strong>red<\/strong>[^<]*<em>/) || [""])[0];
      check("пробел между обёртками остался снаружи", around === "<strong>red</strong> <em>", JSON.stringify(around));
    }
    check("в уведомлении названо число снятых ссылок", /8 ссыл\. убрано/.test(toast), toast.replace(/\n/g, " | "));
    check("отладка видит те же " + LINK_COUNT + " ссылок", dbg && dbg.stripped === LINK_COUNT, dbg ? String(dbg.stripped) : "нет данных");

    // Скриншот главного результата: статья без единой ссылки, текст и разметка целы.
    {
      const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(TMP, "shot-strip.png"), Buffer.from(shot.data, "base64"));
    }

    // ==================== 2. «убрать вместе с текстом» ====================
    console.log("\n=== 2. режим drop: ссылка уходит вместе с текстом ===");
    await setSettings({ stripLinks: "drop" });
    await openPage();
    await selectBody();
    toast = await runTranslate();
    after = await snapshot();
    dbg = await debugInfo();
    console.log("уведомление: %j", toast.replace(/\n/g, " | "));
    console.log("текст:  %s", after.text.slice(0, 200));

    check("ссылок в статье не осталось", after.links.length === 0, JSON.stringify(after.links));
    check("текст ссылок удалён", LINK_ONLY.every((s) => !after.text.includes(s)), LINK_ONLY.filter((s) => after.text.includes(s)).join(", "));
    check("остальной текст не пострадал", KEEP_TEXT.every((s) => after.text.includes(s)));
    check("статья стала короче оригинала", after.text.length < before.text.length, before.text.length + " → " + after.text.length);
    check("картинка внутри ссылки осталась", after.imgs === 1, "img=" + after.imgs);
    // Последний абзац мока состоял из одной ссылки: без её текста он становится
    // пустым и в статью не попадает — блоков стало на один меньше.
    check("опустевший абзац не оставил пустого блока", after.tags.length === before.tags.length - 1, JSON.stringify(after.tags));
    check("в уведомлении названо число снятых ссылок", /8 ссыл\. убрано/.test(toast), toast.replace(/\n/g, " | "));

    // ==================== 3. «не трогать» — прежнее поведение ====================
    console.log("\n=== 3. режим off: ссылки остаются как были ===");
    await setSettings({ stripLinks: "off" });
    await openPage();
    const offBefore = await snapshot();
    await selectBody();
    toast = await runTranslate();
    after = await snapshot();
    dbg = await debugInfo();
    console.log("ссылки: %j", after.links);

    check("все " + LINK_COUNT + " ссылок на месте", after.links.length === LINK_COUNT, String(after.links.length));
    check("адреса не изменились", JSON.stringify(after.links) === JSON.stringify(HREFS), JSON.stringify(after.links));
    // Отдельная проверка на ссылку вокруг картинки: раньше она пропадала всегда —
    // узел запоминался без обёртки. Теперь это регрессия, которую видно сразу.
    check("ссылка вокруг картинки восстановлена", after.links.includes("https://example.com/photo"), JSON.stringify(after.links));
    check("текст статьи не изменился", after.text === offBefore.text);
    check("подпись не размножилась", after.figcaption === 1, "figcaption=" + after.figcaption);
    check("ссылка внутри подписи сохранена",
      (await evalJs(`(document.querySelector('.body figcaption a')||{}).getAttribute ? document.querySelector('.body figcaption a').getAttribute('href') : null`)) === "https://example.com/credits",
      String(await evalJs(`(document.querySelector('.body figcaption a')||{}).getAttribute ? document.querySelector('.body figcaption a').getAttribute('href') : null`)));
    check("в уведомлении нет строки про ссылки", !/ссылок/.test(toast), toast.replace(/\n/g, " | "));
    check("отладка насчитала 0 снятых ссылок", dbg && dbg.stripped === 0, dbg ? String(dbg.stripped) : "нет данных");

    // ==================== 4. чистка одного абзаца ====================
    // Здесь работает другая ветка вставки — заменяется содержимое одного блока,
    // а не пересобирается статья целиком. Ссылки в остальных блоках не трогаем.
    console.log("\n=== 4. выделен один абзац со ссылкой ===");
    await setSettings({ stripLinks: "keep" });
    await openPage();
    const oneBefore = await snapshot();
    const selected = await selectParagraph(1);
    toast = await runTranslate();
    after = await snapshot();
    dbg = await debugInfo();
    console.log("выделено: %j", selected);
    console.log("ссылки:   %j", after.links);

    check("в выделенном абзаце ссылки нет", !(await evalJs(`!!document.querySelectorAll('.body p')[1].querySelector('a')`)));
    check("текст абзаца сохранён", (await evalJs(`document.querySelectorAll('.body p')[1].innerText.replace(/\\s+/g,' ').trim()`)) ===
      "According to the official page, the towing capacity is 3,500 lbs.", await evalJs(`document.querySelectorAll('.body p')[1].innerText.replace(/\\s+/g,' ').trim()`));
    check("жирный в абзаце сохранён", (await evalJs(`document.querySelectorAll('.body p')[1].querySelectorAll('strong').length`)) === 1);
    check("остальные ссылки не тронуты", after.links.length === LINK_COUNT - 1, String(after.links.length));
    check("снята ровно одна ссылка", dbg && dbg.stripped === 1, dbg ? String(dbg.stripped) : "нет данных");
    check("в уведомлении — про одну ссылку", /1 ссыл\. убрано/.test(toast), toast.replace(/\n/g, " | "));

    // ==================== 5. в выделении ссылок нет ====================
    console.log("\n=== 5. в выделенном фрагменте ссылок нет ===");
    await openPage();
    await selectParagraph(0);
    toast = await runTranslate();
    dbg = await debugInfo();
    console.log("уведомление: %j", toast.replace(/\n/g, " | "));
    check("о ссылках не упоминаем", !/ссылок/.test(toast), toast.replace(/\n/g, " | "));
    check("снято 0 ссылок", dbg && dbg.stripped === 0, dbg ? String(dbg.stripped) : "нет данных");
    check("текст абзаца не изменился", (await evalJs(`document.querySelectorAll('.body p')[0].innerText.replace(/\\s+/g,' ').trim()`)) ===
      "The 2026 Subaru Outback keeps the familiar 2.4-liter Boxer engine.");

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (errs.length) {
      console.log("\nисключения:");
      errs.slice(-6).forEach((e) => console.log("  ", JSON.stringify(e.params).slice(0, 300)));
    }
    check("в странице нет исключений", errs.length === 0, errs.length + " шт.");

    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const p = path.join(TMP, "shot-strip-final.png");
    fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
    console.log("\nскриншот последнего сценария: %s", p);

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
