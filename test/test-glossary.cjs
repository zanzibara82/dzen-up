/**
 * Тест глоссария: термины, которые переводчик калечит.
 *
 *   node test-glossary.cjs <путь-к-папке-расширения>
 *
 * Приём: перевод подменяем на «вернуть как есть» (data-dzr-fake-translate="@echo").
 * Тогда единственное, что имеет право измениться в статье, — подстановки
 * глоссария. Всё остальное обязано совпасть символ в символ, а разметка —
 * выжить целиком. Так тест ловит и потерю маркеров, и лишние пробелы,
 * и случайные срабатывания внутри других слов.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const ROOT = PATHS.REPO;
const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-gloss");
const USER_DATA = PATHS.testProfile("gloss");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PAGE = process.argv[3] || "mock5.html";
const PORT_HTTP = 8793;
const CHROME = PATHS.CHROME;

// «feat = ФИТ» — проверка границы слова: внутри «features» срабатывать нельзя.
// «dampers» без «=» — термин, который надо просто оставить как есть.
// Строка с «#» должна игнорироваться.
const GLOSSARY = [
  "# что не переводим",
  "Outback = Аутбэк",
  "Wilderness = Уайлдернесс",
  "turbo engine = турбодвигатель",
  "dampers",
  "feat = ФИТ",
].join("\n");

// ожидаемые подстановки, длинные первыми — как в расширении
const ENTRIES = [
  ["turbo engine", "турбодвигатель"],
  ["Wilderness", "Уайлдернесс"],
  ["Outback", "Аутбэк"],
  ["dampers", "dampers"],
  ["feat", "ФИТ"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// ВНИМАНИЕ: без квадратных скобок — они добавляются при сборке шаблона.
// Если написать здесь "[0-9A-Za-z]", получится [^[0-9A-Za-z]]: вложенный класс,
// который почти никогда не срабатывает (ловится только начало строки).
const W = "0-9A-Za-zА-Яа-яЁё_";

/** То же правило, что в расширении: целое слово, длинные термины первыми. */
function applyGlossary(text) {
  let out = text;
  for (const [from, to] of ENTRIES) {
    const re = new RegExp("(^|[^" + W + "])(" + esc(from) + ")(?![" + W + "])", "gi");
    out = out.replace(re, (m, p1) => p1 + to);
  }
  return out;
}

const norm = (s) => String(s).replace(/\s+/g, " ").trim();

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
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
  const toBrowser = child.stdio[3], fromBrowser = child.stdio[4];
  let buf = "", id = 0;
  const pending = new Map(), events = [];
  fromBrowser.setEncoding("utf8");
  fromBrowser.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!raw.trim()) continue;
      let msg; try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) events.push(msg);
    }
  });
  return {
    events,
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const mid = ++id; pending.set(mid, { res, rej });
        toBrowser.write(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }) + "\0");
        setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); } }, 20000);
      }),
  };
}

async function main() {
  copyDir(SRC_EXT, TEST_EXT);
  const mf = path.join(TEST_EXT, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  const origin = `http://localhost:${PORT_HTTP}/*`;
  m.content_scripts.forEach((cs) => { if (!cs.matches.includes(origin)) cs.matches.push(origin); });
  m.host_permissions = (m.host_permissions || []).concat([origin]);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));

  const server = await startServer();
  const chrome = spawn(CHROME, [
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    "--user-data-dir=" + USER_DATA,
    ...PATHS.chromeFlags(), "--window-size=1280,900", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

  const c = pipeCdp(chrome);
  try {
    let extId = null;
    for (let i = 0; i < 40; i++) {
      try { const r = await c.send("Extensions.loadUnpacked", { path: TEST_EXT }); extId = r.id; break; }
      catch (e) { if (i === 39) throw e; await sleep(400); }
    }
    await PATHS.clearStorage(c, extId, TEST_EXT);

    // Настройки: глоссарий пишем через штатный канал (saveSettings), а не напрямую
    // в storage. Так тест ходит тем же путём, что и попап, и заодно поймает, если
    // глоссарий переедет в другое хранилище и перестанет доезжать до контент-скрипта.
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
      // Чистку ссылок выключаем: этот набор проверяет глоссарий, и ссылка здесь —
      // просто представитель инлайн-разметки вокруг термина. Политика «что делать
      // со ссылками из оригинала» — отдельная задача и проверяется в test-strip.cjs.
      const patch = { glossary: GLOSSARY, preview: false, stripLinks: "off" };
      let applied = false;
      for (let i = 0; i < 8; i++) {
        const res = await ev(`__send({ type: 'saveSettings', settings: ${JSON.stringify(patch)} })`);
        const raw = await ev(`__send({ type: 'getSettings' }).then((r) => JSON.stringify((r || {}).settings || {}))`);
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (e) {}
        if (res && res.ok && parsed.glossary === GLOSSARY && parsed.preview === false && parsed.stripLinks === "off") {
          applied = true;
          break;
        }
        await sleep(400);
      }
      if (!applied) throw new Error("не удалось применить настройки для теста глоссария");
      await c.send("Target.closeTarget", { targetId: pv.targetId });
    }

    const { targetId } = await c.send("Target.createTarget", { url: `http://localhost:${PORT_HTTP}/${PAGE}` });
    const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
    await c.send("Runtime.enable", {}, sessionId);
    await c.send("Page.enable", {}, sessionId);

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
    await sleep(700); // даём loadSettings() доехать

    const snapshot = () => evalJs(`(() => {
      const ed = document.querySelector('.body');
      const q = (s) => ed.querySelectorAll(s).length;
      return {
        text: ed.innerText,
        imgs: q('img'), brs: q('br'), strong: q('strong'), tables: q('table'),
        cells: q('td'), nestedUl: ed.querySelectorAll('ul ul').length,
        lis: q('li'), quotes: q('blockquote'), heads: q('h2'),
        href: (ed.querySelector('h2 a') || {}).getAttribute ? ed.querySelector('h2 a').getAttribute('href') : null
      };
    })()`);

    const before = await snapshot();
    check("в статье есть термины для проверки", /Outback/.test(before.text) && /Wilderness/.test(before.text));
    check("картинка на месте до правки", before.imgs === 1, "img=" + before.imgs);

    // выделяем всё содержимое редактора
    await evalJs(`(() => {
      const ed = document.querySelector('.body');
      const r = document.createRange();
      r.selectNodeContents(ed);
      const s = window.getSelection();
      s.removeAllRanges(); s.addRange(r);
    })()`);
    // настоящий mouseup: selectionchange приходит асинхронно, а страница
    // может сбросить выделение на focusout
    {
      const p = await evalJs(`(() => { const r = document.querySelector('.body').getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + 20 }; })()`);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none" }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 }, sessionId);
      await sleep(80);
    }

    const rect = await evalJs(`(() => { const b = document.querySelector('#dzr-bar .dzr-go');
      const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" }, sessionId);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);

    // ждём вставку
    for (let i = 0; i < 40; i++) {
      const t = await evalJs(`document.querySelector('.body').innerText`);
      if (/Аутбэк|турбодвигатель/.test(t)) break;
      await sleep(250);
    }

    const after = await snapshot();
    const dbg = JSON.parse((await evalJs(`document.documentElement.getAttribute("data-dzr-debug-info")`)) || "null");

    console.log("");
    console.log("=== глоссарий применился ===");
    check("«Outback» → «Аутбэк»", /Аутбэк/.test(after.text), JSON.stringify(after.text.slice(0, 90)));
    check("«Wilderness» → «Уайлдернесс»", /Уайлдернесс/.test(after.text));
    check("«turbo engine» → «турбодвигатель»", /турбодвигатель/.test(after.text));
    check("«dampers» остался как есть", /dampers/.test(after.text));
    check("исходных «Outback»/«Wilderness» в тексте не осталось",
      !/Outback|Wilderness/.test(after.text), JSON.stringify(after.text.slice(0, 90)));

    console.log("");
    console.log("=== границы слов и разметка ===");
    check("«feat» не тронул «features»", /features/.test(after.text) && !/ФИТ/.test(after.text));
    check("жирный вокруг термина сохранён", after.strong === before.strong, "strong=" + after.strong);
    check("картинка сохранена", after.imgs === before.imgs, "img=" + after.imgs);
    check("перенос строки сохранён", after.brs === before.brs, "br=" + after.brs);
    check("вложенный список сохранён", after.nestedUl === before.nestedUl, "ul ul=" + after.nestedUl);
    check("пункты списка на месте", after.lis === before.lis, "li=" + after.lis);
    check("цитата сохранена", after.quotes === before.quotes);
    check("заголовок сохранён", after.heads === before.heads);
    check("таблица не тронута", after.tables === before.tables && after.cells === before.cells,
      "table=" + after.tables + ", td=" + after.cells);
    check("ссылка сохранила href", after.href === before.href, String(after.href));
    check("в тексте нет маркеров", !/\[\[|\]\]/.test(after.text));

    console.log("");
    console.log("=== кроме глоссария текст не изменился ===");
    const expected = norm(applyGlossary(before.text));
    const actual = norm(after.text);
    check("текст совпадает с ожидаемым", expected === actual,
      expected === actual ? "" : "\n    ждали: " + expected.slice(0, 160) + "\n    вышло: " + actual.slice(0, 160));

    if (dbg) {
      console.log("\n[debug] блоки: %s", JSON.stringify(dbg.blocks));
      console.log("[debug] маркеры: %s", JSON.stringify(dbg.tokens));
    }

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    check("в странице нет исключений", errs.length === 0, errs.length ? JSON.stringify(errs[0].params).slice(0, 200) : "");
  } finally {
    try { execSync("taskkill /F /T /PID " + chrome.pid, { stdio: "ignore" }); } catch (e) {}
    try { server.close(); } catch (e) {}
    const bad = results.filter((r) => !r.ok);
    console.log("");
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e && e.message); process.exit(1); });
