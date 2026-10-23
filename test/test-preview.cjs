/**
 * Тест предпросмотра «до → после».
 *
 *   node test-preview.cjs <путь-к-папке-расширения> [страница.html]
 *
 * Проверяем главное обещание предпросмотра: пока пользователь не нажал
 * «Применить», текст статьи не меняется НИКАК. Отмена и Esc — тоже не меняют.
 *
 * Перевод подменяем через data-dzr-fake-translate, поэтому сети не нужно
 * и прогон детерминированный.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const ROOT = PATHS.REPO;
const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-preview");
const USER_DATA = PATHS.testProfile("preview");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PAGE = process.argv[3] || "mock.html";
const PORT_HTTP = 8790;
const CHROME = PATHS.CHROME;

// подставной «перевод»: по нему однозначно видно, применился он или нет
const FAKE = "ПРЕДПРОСМОТР: подставной перевод для проверки.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
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
      }),
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
      ...PATHS.chromeFlags(),
      "--window-size=1280,900",
      "about:blank",
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

    // предпросмотр должен быть включён (это значение по умолчанию)
    {
      const pv = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
      const s2 = await c.send("Target.attachToTarget", { targetId: pv.targetId, flatten: true });
      await c.send("Runtime.enable", {}, s2.sessionId);
      // Попап открывается в новом таргете: сначала в нём пустой документ, где
      // chrome.storage ещё нет, и запись ушла бы в никуда.
      for (let i = 0; i < 30; i++) {
        const r = await c.send(
          "Runtime.evaluate",
          {
            expression: `typeof chrome !== 'undefined' && !!chrome.storage && !!document.getElementById('save')`,
            returnByValue: true,
            awaitPromise: true
          },
          s2.sessionId
        );
        if (r.result && r.result.value) break;
        await sleep(200);
      }
      await c.send(
        "Runtime.evaluate",
        { expression: "chrome.storage.sync.remove('preview')", returnByValue: true, awaitPromise: true },
        s2.sessionId
      );
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
    await evalJs(`document.documentElement.setAttribute("data-dzr-debug","1")`);
    await evalJs(`document.documentElement.setAttribute("data-dzr-fake-translate", ${JSON.stringify(FAKE)})`);

    const bodyText = () => evalJs(`document.querySelector('.body').innerText`);
    const hasPreview = () => evalJs(`!!document.getElementById('dzr-preview')`);

    const clickEl = async (selector) => {
      const rect = await evalJs(`(() => {
        const b = document.querySelector(${JSON.stringify(selector)});
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`);
      if (!rect) throw new Error("нет элемента " + selector);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
    };

    const key = async (k, code, vk, modifiers) => {
      await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers }, sessionId);
      await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers }, sessionId);
    };

    // выделяем второй пункт списка и жмём кнопку панели
    const selectAndGo = async () => {
      await evalJs(`(() => {
        const li = document.querySelectorAll('.body li')[1];
        const r = document.createRange();
        r.selectNodeContents(li);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(r);
      })()`);
      await clickEl("#dzr-bar .dzr-go");
      for (let i = 0; i < 30; i++) {
        if (await hasPreview()) break;
        await sleep(150);
      }
    };

    const before = await bodyText();

    // ---------------------------------------------- A: карточка показывается ---
    console.log("=== A: предпросмотр показывается ===");
    await selectAndGo();

    check("карточка предпросмотра появилась", await hasPreview());

    const card = await evalJs(`(() => {
      const p = document.getElementById('dzr-preview');
      if (!p) return null;
      const btn = (s) => { const b = p.querySelector(s); return b ? b.textContent.trim() : null; };
      return {
        head: p.querySelector('.dzr-pv-head') ? p.querySelector('.dzr-pv-head').textContent : '',
        body: p.querySelector('.dzr-pv-body') ? p.querySelector('.dzr-pv-body').innerText : '',
        apply: btn('.dzr-pv-apply'),
        cancel: btn('.dzr-pv-cancel'),
        status: document.querySelector('#dzr-bar .dzr-status').textContent,
        goLabel: document.querySelector('#dzr-bar .dzr-go').textContent.trim(),
        inView: (() => {
          const r = p.getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
        })()
      };
    })()`);

    check("в карточке виден переведённый текст", !!card && card.body.includes("ПРЕДПРОСМОТР"), card ? JSON.stringify(card.body.slice(0, 60)) : "карточки нет");
    check("есть кнопка «Применить»", !!card && card.apply === "Применить", card ? String(card.apply) : "");
    check("есть кнопка «Отмена»", !!card && card.cancel === "Отмена", card ? String(card.cancel) : "");
    check("карточка вписалась в экран", !!card && card.inView);
    check("статус говорит о предпросмотре", !!card && /предпросмотр/i.test(card.status), card ? card.status : "");
    check("кнопка панели вернулась в обычное состояние", !!card && /Перевести/.test(card.goLabel), card ? card.goLabel : "");

    // ------------------------------------------------ главное обещание ---
    check("СТАТЬЯ ЕЩЁ НЕ ИЗМЕНЕНА", (await bodyText()) === before);

    // скриншот именно с открытой карточкой — для отчёта
    {
      const shotOpen = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(TMP, "shot-preview-open.png"), Buffer.from(shotOpen.data, "base64"));
    }

    // Ждём состояние, а не «прошло N миллисекунд». Пауза измеряет скорость
    // машины: под нагрузкой полного прогона вставка в редактор не укладывалась в
    // 600 мс, и проверки «текст изменился» падали через раз — в одиночном
    // прогоне набор был зелёным. Опрос по состоянию статьи и карточки от
    // скорости машины не зависит.
    const waitTextChanged = async () => {
      for (let i = 0; i < 40; i++) {
        if ((await bodyText()) !== before) return true;
        await sleep(150);
      }
      return false;
    };
    const waitNoPreview = async () => {
      for (let i = 0; i < 40; i++) {
        if (!(await hasPreview())) return true;
        await sleep(150);
      }
      return false;
    };
    const waitSecondItem = async () => {
      for (let i = 0; i < 40; i++) {
        const t = await evalJs(
          `document.querySelector('.body li:nth-child(2)') ? document.querySelector('.body li:nth-child(2)').innerText : ''`
        );
        if (t.includes("ПРЕДПРОСМОТР")) return t;
        await sleep(150);
      }
      return "";
    };

    // ------------------------------------------------ B: Esc отменяет ---
    console.log("=== B: Esc закрывает и не вставляет ===");
    await key("Escape", "Escape", 27, 0);
    await waitNoPreview();
    check("карточка закрылась", !(await hasPreview()));
    check("статья не изменена", (await bodyText()) === before);

    // ------------------------------------------------ C: «Отмена» ---
    console.log("=== C: «Отмена» не вставляет ===");
    await selectAndGo();
    check("карточка снова открылась", await hasPreview());
    await clickEl("#dzr-preview .dzr-pv-cancel");
    await waitNoPreview();
    check("карточка закрылась", !(await hasPreview()));
    check("статья не изменена", (await bodyText()) === before);
    const cancelToast = await evalJs(`(document.getElementById('dzr-toast')||{}).textContent || ''`);
    check("в уведомлении сказано, что текст не изменён", /не изменён/i.test(cancelToast), JSON.stringify(cancelToast.slice(0, 80)));

    // ------------------------------------------------ D: «Применить» ---
    console.log("=== D: «Применить» вставляет ===");
    await selectAndGo();
    check("карточка открылась", await hasPreview());
    await clickEl("#dzr-preview .dzr-pv-apply");
    await waitTextChanged();
    check("карточка закрылась", !(await hasPreview()));
    const applied = await bodyText();
    check("текст статьи изменился", applied !== before);
    check("в статье именно переведённый текст", applied.includes("ПРЕДПРОСМОТР"), JSON.stringify(applied.slice(0, 80)));
    const undoVisible = await evalJs(`!document.querySelector('#dzr-bar .dzr-icon-btn[title*="Отменить вставку"]').hidden`);
    check("появилась кнопка отката", undoVisible === true);

    // ------------------------------------------------ E: Ctrl+Enter ---
    console.log("=== E: Ctrl+Enter применяет ===");
    await selectAndGo();
    check("карточка открылась", await hasPreview());
    await key("Enter", "Enter", 13, 2); // 2 = Ctrl
    await waitNoPreview();
    check("карточка закрылась", !(await hasPreview()));
    const applied2 = await waitSecondItem();
    check("второй пункт содержит перевод", applied2.includes("ПРЕДПРОСМОТР"), JSON.stringify(applied2.slice(0, 80)));

    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    fs.writeFileSync(path.join(TMP, "shot-preview.png"), Buffer.from(shot.data, "base64"));

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    check("в странице нет исключений", errs.length === 0, errs.length ? JSON.stringify(errs[0].params).slice(0, 200) : "");
  } finally {
    killChrome(chrome);
    try { server.close(); } catch (e) {}
    const bad = results.filter((r) => !r.ok);
    console.log("");
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
  }
}

main().catch((e) => {
  console.error("ОШИБКА ТЕСТА:", e && e.message);
  process.exit(1);
});
