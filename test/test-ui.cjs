/**
 * Проверка UI-поведения панели: закрытие крестиком и перестройка в вертикальный
 * режим при перетаскивании к левому/правому краю.
 *
 *   node test-ui.cjs <путь-к-папке-расширения>
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const PATHS = require("./paths.cjs");

const ROOT = PATHS.REPO;
const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-ui");
const USER_DATA = PATHS.testProfile("ui");
const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PORT_HTTP = 8788;
const CHROME = PATHS.CHROME;
const PAGE = "mock.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Раньше этот харнесс только печатал результат, и провал в нём был виден лишь
// по коду возврата — то есть никак. Теперь считаем проверки, как остальные.
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

function prepare() {
  copyDir(SRC_EXT, TEST_EXT);
  const mf = path.join(TEST_EXT, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  const origin = `http://localhost:${PORT_HTTP}/*`;
  m.content_scripts.forEach((cs) => { if (!cs.matches.includes(origin)) cs.matches.push(origin); });
  m.host_permissions = (m.host_permissions || []).concat([origin]);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
}

function startServer() {
  const server = http.createServer((req, res) => {
    const file = path.join(MOCK_DIR, (req.url === "/" ? "/mock.html" : req.url).split("?")[0]);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
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
        setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); } }, 20000);
      }),
  };
}

async function main() {
  prepare();
  const server = await startServer();
  const chrome = spawn(CHROME, [
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--user-data-dir=" + USER_DATA,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

  const c = pipeCdp(chrome);
  let sessionId, evalJs, pageTargetId;
  const mouse = (type, x, y, buttons) =>
    c.send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", clickCount: 1, buttons: buttons,
    }, sessionId);

  async function openPage() {
    if (pageTargetId) { await c.send("Target.closeTarget", { targetId: pageTargetId }); }
    const { targetId } = await c.send("Target.createTarget", { url: `http://localhost:${PORT_HTTP}/${PAGE}` });
    pageTargetId = targetId;
    const r = await c.send("Target.attachToTarget", { targetId, flatten: true });
    sessionId = r.sessionId;
    await c.send("Runtime.enable", {}, sessionId);
    await c.send("Page.enable", {}, sessionId);
    evalJs = async (expression) => {
      const res = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
      return res.result.value;
    };
    for (let i = 0; i < 40; i++) {
      if (await evalJs(`!!document.getElementById('dzr-bar') && document.documentElement.getAttribute('data-dzr-settings') === 'ready'`)) return true;
      await sleep(250);
    }
    return false;
  }

  const rectOf = (sel) => evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, left: r.left, right: r.right, top: r.top, w: r.width, h: r.height };
  })()`);

  try {
    let extId = null;
    for (let i = 0; i < 40; i++) {
      try { extId = (await c.send("Extensions.loadUnpacked", { path: TEST_EXT })).id; break; }
      catch (e) { if (i === 39) throw e; await sleep(400); }
    }
    await PATHS.clearStorage(c, extId, TEST_EXT);

    // ---------- ТЕСТ 1: крестик ----------
    console.log("=== ТЕСТ 1: закрытие крестиком ===");
    if (!(await openPage())) throw new Error("панель не появилась");
    let r = await rectOf('#dzr-bar button[title^="Скрыть"]');
    if (!r) throw new Error("не нашёл кнопку закрытия");
    await mouse("mousePressed", r.x, r.y, 1);
    await mouse("mouseReleased", r.x, r.y, 0);
    await sleep(900);
    const gone = await evalJs(`!document.getElementById('dzr-bar')`);
    console.log("панель закрылась и не вернулась:", gone ? "ДА" : "НЕТ (баг)");
    check("крестик скрывает панель, и она не возвращается", gone === true);

    // ---------- ТЕСТ 2: перетаскивание к левому краю ----------
    console.log("\n=== ТЕСТ 2: перетаскивание к левому краю ===");
    if (!(await openPage())) throw new Error("панель не появилась после перезагрузки");
    const before = await rectOf("#dzr-bar");
    console.log("до перетаскивания : left=%d, ширина=%d, высота=%d, vertical=%s",
      Math.round(before.left), Math.round(before.w), Math.round(before.h),
      await evalJs(`document.getElementById('dzr-bar').classList.contains('dzr-vertical')`));

    const grip = await rectOf("#dzr-bar .dzr-grip");
    await mouse("mousePressed", grip.x, grip.y, 1);
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = grip.x + ((30 - grip.x) * i) / steps;
      const y = grip.y + ((260 - grip.y) * i) / steps;
      await mouse("mouseMoved", x, y, 1);
      await sleep(25);
    }
    await mouse("mouseReleased", 30, 260, 0);
    await sleep(400);

    const afterLeft = await rectOf("#dzr-bar");
    const vertLeft = await evalJs(`document.getElementById('dzr-bar').classList.contains('dzr-vertical')`);
    console.log("после (левый край): left=%d, ширина=%d, высота=%d, vertical=%s",
      Math.round(afterLeft.left), Math.round(afterLeft.w), Math.round(afterLeft.h), vertLeft);
    check("у левого края панель встаёт вертикально", vertLeft === true && afterLeft.h > afterLeft.w,
      "vertical=" + vertLeft + ", " + Math.round(afterLeft.w) + "x" + Math.round(afterLeft.h));

    // ---------- ТЕСТ 3: перетаскивание к правому краю ----------
    console.log("\n=== ТЕСТ 3: перетаскивание к правому краю ===");
    const grip2 = await rectOf("#dzr-bar .dzr-grip");
    await mouse("mousePressed", grip2.x, grip2.y, 1);
    for (let i = 1; i <= steps; i++) {
      const x = grip2.x + ((1240 - grip2.x) * i) / steps;
      const y = grip2.y + ((400 - grip2.y) * i) / steps;
      await mouse("mouseMoved", x, y, 1);
      await sleep(25);
    }
    await mouse("mouseReleased", 1240, 400, 0);
    await sleep(400);
    const afterRight = await rectOf("#dzr-bar");
    const vertRight = await evalJs(`document.getElementById('dzr-bar').classList.contains('dzr-vertical')`);
    const vw = await evalJs(`window.innerWidth`);
    console.log("после (правый край): right=%d (окно %d), ширина=%d, vertical=%s",
      Math.round(afterRight.right), vw, Math.round(afterRight.w), vertRight);
    check("у правого края панель вертикальная и не вылезает за окно",
      vertRight === true && afterRight.right <= vw + 1,
      "vertical=" + vertRight + ", right=" + Math.round(afterRight.right) + " при окне " + vw);

    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const shotPath = path.join(TMP, "shot-vertical.png");
    fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
    console.log("\nскриншот:", shotPath);

    // ---------- ТЕСТ 4: возврат в центр ----------
    console.log("\n=== ТЕСТ 4: возврат в центр ===");
    const grip3 = await rectOf("#dzr-bar .dzr-grip");
    await mouse("mousePressed", grip3.x, grip3.y, 1);
    for (let i = 1; i <= steps; i++) {
      const x = grip3.x + ((640 - grip3.x) * i) / steps;
      const y = grip3.y + ((760 - grip3.y) * i) / steps;
      await mouse("mouseMoved", x, y, 1);
      await sleep(25);
    }
    await mouse("mouseReleased", 640, 760, 0);
    await sleep(400);
    const back = await rectOf("#dzr-bar");
    const vertBack = await evalJs(`document.getElementById('dzr-bar').classList.contains('dzr-vertical')`);
    console.log("после возврата: left=%d, ширина=%d, высота=%d, vertical=%s",
      Math.round(back.left), Math.round(back.w), Math.round(back.h), vertBack);
    check("в центре панель снова горизонтальная", vertBack === false, "vertical=" + vertBack);

    // ---------- ТЕСТ 5: стиль рерайта в панели ----------
    console.log("\n=== ТЕСТ 5: стиль рерайта ===");

    // Эталонные тексты пресетов берём из СОБРАННОЙ папки: так тест заодно ловит
    // «забыли положить presets.js в сборку».
    const presetsFile = path.join(SRC_EXT, "presets.js");
    if (!fs.existsSync(presetsFile)) throw new Error("в сборке нет presets.js: " + presetsFile);
    delete globalThis.DzenPresets;
    require(presetsFile);
    const P = globalThis.DzenPresets;
    if (!P) throw new Error("presets.js не выставил globalThis.DzenPresets");
    console.log("пресетов в сборке: %d", P.list.length);

    // Настройки читаем со страницы попапа: только у неё есть доступ к chrome.storage.
    const probe = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    const probeSession = (await c.send("Target.attachToTarget", { targetId: probe.targetId, flatten: true })).sessionId;
    await c.send("Runtime.enable", {}, probeSession);
    const probeEval = async (expression) => {
      const res = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, probeSession);
      if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
      return res.result.value;
    };
    // Попап открывается в новом таргете, и сначала в нём живёт пустой документ:
    // всё, что мы успели там определить, теряется вместе с ним. Поэтому помощник
    // не «висит» в window, а объявляется заново в каждом обращении — иначе тест
    // падает на ReferenceError: __get is not defined посреди прогона.
    for (let i = 0; i < 30; i++) {
      if (await probeEval(`!!document.getElementById('save')`)) break;
      await sleep(200);
    }
    const readSettings = () =>
      probeEval(
        `(async () => {
          const s = await new Promise((res) => chrome.runtime.sendMessage({ type: 'getSettings' }, (r) => res((r || {}).settings || {})));
          return JSON.stringify({ aiPreset: s.aiPreset, aiPrompt: s.aiPrompt, mode: s.mode });
        })()`
      ).then((t) => JSON.parse(t));

    const presetUi = await evalJs(`(() => {
      const sel = document.querySelector('#dzr-bar .dzr-controls select[title^="Стиль"]');
      if (!sel) return { exists: false };
      return {
        exists: true,
        count: sel.options.length,
        ids: Array.from(sel.options).map((o) => o.value),
        shorts: Array.from(sel.options).map((o) => o.getAttribute('data-short')),
        value: sel.value,
        hidden: sel.hidden
      };
    })()`);
    console.log("селект стиля: %j", Object.assign({}, presetUi, { ids: (presetUi.ids || []).length + " шт." }));
    check("в панели есть селект стиля рерайта", presetUi.exists === true);
    check("в панели перечислены все пресеты из presets.js",
      presetUi.exists && presetUi.count === P.list.length,
      "в панели: " + presetUi.count + ", в presets.js: " + P.list.length);
    check("у каждого пункта есть короткая подпись для вертикальной панели",
      (presetUi.shorts || []).every((s) => !!s), JSON.stringify(presetUi.shorts));
    check("панель показывает сохранённый стиль", !!P.byId(presetUi.value), String(presetUi.value));

    const styleBefore = await readSettings();
    // Меняем стиль так же, как пользователь: выбор в селекте. Панель обязана
    // сохранить и стиль, и его текст — воркер читает настройки на каждый запрос.
    await evalJs(`(() => {
      const sel = document.querySelector('#dzr-bar .dzr-controls select[title^="Стиль"]');
      sel.value = 'news';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);
    await sleep(1200);
    const styleAfter = await readSettings();
    check("панель сохранила выбранный стиль", styleAfter.aiPreset === 'news', JSON.stringify({ до: styleBefore.aiPreset, после: styleAfter.aiPreset }));
    check("вместе со стилем сохранился его промпт", styleAfter.aiPrompt === P.promptOf('news'), JSON.stringify(String(styleAfter.aiPrompt).slice(0, 48)));

    // Стиль нужен только там, где работает AI: в режиме «только перевод» он лишний
    const vis = await evalJs(`(() => {
      const mode = document.querySelector('#dzr-bar .dzr-controls select[title^="Что делать"]');
      const sel = document.querySelector('#dzr-bar .dzr-controls select[title^="Стиль"]');
      mode.value = 'translate';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      const inTranslate = sel.hidden;
      mode.value = 'translate+rewrite';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      return { inTranslate: inTranslate, inRewrite: sel.hidden };
    })()`);
    check("в режиме «только перевод» стиль скрыт", vis.inTranslate === true, JSON.stringify(vis));
    check("в режиме рерайта стиль снова виден", vis.inRewrite === false, JSON.stringify(vis));

    // Две смены режима подряд — две асинхронные записи в хранилище. Проверяем,
    // что победил последний выбор, и при необходимости доставляем его сами.
    await sleep(800);
    if ((await readSettings()).mode !== 'translate+rewrite') {
      await probeEval(
        `new Promise((res) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { mode: 'translate+rewrite' } }, () => res(true)))`
      );
    }
    await c.send("Target.closeTarget", { targetId: probe.targetId });

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (errs.length) {
      console.log("\nисключения:");
      errs.slice(-6).forEach((e) => console.log("  ", JSON.stringify(e.params).slice(0, 250)));
    }
  } finally {
    killChrome(chrome);
    server.close();
  }
}

main()
  .then(() => {
    console.log("\n=== ИТОГ ===");
    const bad = results.filter((r) => !r.ok);
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
    bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
    process.exitCode = bad.length ? 1 : 0;
  })
  .catch((e) => { console.error("ОШИБКА ТЕСТА:", e.message || e); process.exit(1); });

/** На Windows chrome.kill() не убивает дерево процессов — добиваем taskkill. */
function killChrome(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      require("child_process").execSync("taskkill /F /T /PID " + child.pid, { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch {}
}
