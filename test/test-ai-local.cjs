/**
 * Тест своей модели (Ollama и подобных) в панели на странице.
 *
 *   node test-ai-local.cjs <путь-к-папке-расширения>
 *
 * Зачем отдельный набор. Локальная модель — самый дешёвый способ включить
 * рерайт, и у неё три отличия от облака, каждое из которых ломало работу:
 *   • ключа у неё нет — расширение отказывало в рерайте («не указан ключ»);
 *   • отвечает она минутами — потолок в 90 секунд обрывал ответ, а три повтора
 *     превращали ожидание в четверть часа;
 *   • повторять её бессмысленно: она не «сбойнула», она считает.
 * Плюс человек не должен смотреть на неподвижное «Рерайчу…» и думать, что
 * расширение зависло.
 *
 * Настоящую Ollama тест не трогает: сервер поднимается свой, на 127.0.0.1, и
 * отвечает медленно — ровно настолько, чтобы секунды в панели успели пойти.
 * Адрес расширению выдаётся правом в манифесте копии, потому что кнопка выдачи
 * доступа требует настоящего нажатия и в тесте её не нажать.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-ai-local");
const USER_DATA = PATHS.testProfile("ai-local");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PORT_HTTP = 8791;
const CHROME = PATHS.CHROME;

// Адрес своей машины — и для страницы, и для модели: одно право на оба.
const SITE = `http://127.0.0.1:${PORT_HTTP}`;
const PAGE = "mock.html";
const MODEL = "qwen2.5:7b";
const ANSWER = "Текст переписан своей моделью на машине автора.";
// Ответ не мгновенный: только так видно, что панель показывает ожидание,
// а не молчит. Это не «сон ради сна» — медленный ответ и есть предмет проверки.
const DELAY_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}

/**
 * Уведомление многострочное (в нём результат, оговорки и отмена), а в логе
 * нужна одна строка: иначе разбор прогона превращается в чтение обрывков —
 * «✅ Готово!» и всё, а причина отказа осталась на следующей строке.
 */
function oneLine(s) {
  return String(s || "").replace(/\s*\n+\s*/g, " | ").trim();
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Что пришло на /chat/completions — по этому и судим о запросе. */
const seen = [];

function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];

    if (url === "/v1/chat/completions" || url === "/v1-broken/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url, headers: req.headers, body });
        const broken = url.indexOf("broken") > 0;
        const answer = () => {
          if (broken) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end('{"error":{"message":"модель упала"}}');
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              model: MODEL,
              choices: [{ index: 0, message: { role: "assistant", content: ANSWER } }]
            })
          );
        };
        setTimeout(answer, broken ? 300 : DELAY_MS);
      });
      return;
    }

    // Предполётный запрос: у расширения есть право на домен, но пусть сервер
    // отвечает как положено — иначе тест проверял бы не то, что происходит
    // в жизни, а свою удачу.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
      });
      res.end();
      return;
    }

    const file = path.join(MOCK_DIR, url === "/" ? PAGE : url.replace(/^\//, ""));
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
  const origin = `${SITE}/*`;
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

    // ------------------------------------------------ настройки через попап ---
    // Настройки кладём сообщением из попапа: у страницы Дзена нет доступа к
    // хранилищу расширения, а подделывать его файлами нельзя (профиль не
    // отдаёт свои файлы) — попап же и есть тот путь, которым ходит человек.
    const popup = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    const ps = await c.send("Target.attachToTarget", { targetId: popup.targetId, flatten: true });
    await c.send("Runtime.enable", {}, ps.sessionId);
    const probeEval = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, ps.sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };
    // Попап открывается новым таргетом, и до перехода на popup.html в нём живёт
    // пустой документ: помощник, определённый раньше, теряется вместе с ним.
    // Сначала ждём появления кнопки, и только потом трогаем documentElement —
    // у пустого документа его ещё нет, и обращение к нему роняет проверку
    // («Cannot read properties of null (reading 'getAttribute')»). Именно так
    // этот набор падал в полном прогоне, проходя в одиночку.
    for (let i = 0; i < 40; i++) {
      if (await probeEval(`!!document.getElementById('save')`)) break;
      await sleep(150);
    }
    // Ждём не появления кнопки, а применённых настроек: поля попапа заполняются
    // асинхронно, и чтение в этот промежуток даёт пустое значение.
    for (let i = 0; i < 40; i++) {
      if (
        await probeEval(
          `!!document.documentElement && document.documentElement.getAttribute('data-dzr-popup') === 'ready'`
        )
      ) {
        break;
      }
      await sleep(150);
    }
    await probeEval(
      `window.__send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, ` +
        `(r) => res(r || { ok: false, error: String(((chrome.runtime.lastError || {}).message) || "нет ответа") }))); true`
    );

    const setSettings = async (patch) => {
      const want = Object.keys(patch);
      for (let i = 0; i < 8; i++) {
        const res = await probeEval(`__send({ type: 'saveSettings', settings: ${JSON.stringify(patch)} })`);
        const raw = await probeEval(
          `__send({ type: 'getSettings' }).then((r) => JSON.stringify((r || {}).settings || {}))`
        );
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (e) {}
        if (res && res.ok && want.every((k) => parsed[k] === patch[k])) return parsed;
        await sleep(400);
      }
      throw new Error("не удалось применить настройки: " + JSON.stringify(patch));
    };

    // ------------------------------------------------ страница и панель ---
    let targetId = null, sessionId = null;
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

    const statusText = () => evalJs(`(document.querySelector('#dzr-bar .dzr-status') || {}).textContent || ''`);
    const toastText = () => evalJs(`(document.getElementById('dzr-toast') || {}).innerText || ''`);
    const resetToast = () => evalJs(`(() => {
      const t = document.getElementById('dzr-toast');
      if (t) { t.innerHTML = ''; t.classList.remove('dzr-show'); }
      return true;
    })()`);

    // Настоящий mouseup после программного выделения: selectionchange приходит
    // асинхронно, и панель иногда видит пустое выделение и отказывается работать.
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

    const bodyText = () => evalJs(`document.querySelector('.body').innerText.replace(/\\s+/g, ' ').trim()`);

    /** Жмём «Рерайт» и собираем всё, что панель успела сказать, пока считала. */
    const runAndWatch = async (limitMs) => {
      await resetToast();
      await clickEl("#dzr-bar .dzr-go");
      const samples = [];
      const until = Date.now() + limitMs;
      while (Date.now() < until) {
        samples.push(await statusText());
        const t = await toastText();
        if (/Готово|Ошибка|Не удалось|AI недоступен/.test(t)) return { samples, toast: t };
        await sleep(150);
      }
      return { samples, toast: await toastText() };
    };

    // ==================== A. своя модель отвечает, ключа нет ====================
    console.log("\n=== A. своя модель: без ключа, ждать долго ===");
    await setSettings({
      aiEnabled: true,
      aiBaseUrl: `${SITE}/v1`,
      aiModel: MODEL,
      aiKey: "",
      mode: "rewrite",
      // Предпросмотр выключен намеренно: с ним текст в статью не попадает, пока
      // не нажато «Применить», и проверка «текст заменён» проверяла бы окно.
      preview: false
    });
    seen.length = 0;
    await openPage();
    const selLen = await selectBody();
    check("выделение статьи сделано", selLen > 200, "символов: " + selLen);

    const a = await runAndWatch(DELAY_MS + 6000);
    const ticked = a.samples.filter((s) => /Рерайчу…\s*\d+\s*с/.test(s));
    const withNote = a.samples.filter((s) => /своя модель/.test(s));
    check("панель считает секунды, а не молчит", ticked.length > 0, ticked[0] || JSON.stringify(a.samples.slice(0, 3)));
    check("в статусе сказано, что своя модель отвечает небыстро", withNote.length > 0, withNote[0] || "");
    check("рерайт дошёл до конца", /Готово/.test(a.toast), oneLine(a.toast) || "тоста нет");
    check("текст статьи заменён ответом своей модели", (await bodyText()).indexOf(ANSWER) >= 0, (await bodyText()).slice(0, 80));

    // После ответа секунды идти не должны: застывший счётчик читался бы как
    // «оно всё ещё работает».
    await sleep(2200);
    check("после ответа секунды больше не идут", !/Рерайчу/.test(await statusText()), await statusText());

    // Запрос: без ключа, с той моделью, что выбрана, и ровно один.
    check("запрос к модели ушёл один раз", seen.length === 1, "запросов: " + seen.length);
    check("пустой ключ не ушёл заголовком", seen[0] && seen[0].headers.authorization === undefined, String(seen[0] && seen[0].headers.authorization));
    let sentBody = {};
    try { sentBody = JSON.parse((seen[0] || {}).body || "{}"); } catch (e) {}
    check("названа выбранная модель", sentBody.model === MODEL, String(sentBody.model));
    check("текст статьи уехал в запрос", String(sentBody.messages && sentBody.messages[1] && sentBody.messages[1].content || "").length > 200, "символов: " + String((sentBody.messages || [])[1] ? sentBody.messages[1].content.length : 0));

    // ==================== B. модель упала: попытка одна ====================
    console.log("\n=== B. своя модель упала: одна попытка и честный тост ===");
    await setSettings({ aiBaseUrl: `${SITE}/v1-broken`, preview: false });
    seen.length = 0;
    await openPage();
    await selectBody();
    const b = await runAndWatch(8000);
    // Отказ AI и результат — ОДНО уведомление. Пока их было два, второе
    // («Готово») затирало первое, и человек видел успех там, где модель не
    // работала вовсе.
    check("отказ AI и результат — одно уведомление", /Готово/.test(b.toast) && /AI недоступен/.test(b.toast), oneLine(b.toast) || "тоста нет");
    check("в уведомлении назван код ответа", /HTTP 500/.test(b.toast), oneLine(b.toast));
    check("сказано, что текст переписан встроенным рерайтером", /встроенным рерайтером/.test(b.toast), oneLine(b.toast));
    check("своя модель не заставляет ждать повторов", seen.length === 1, "запросов: " + seen.length);
    check("текст статьи всё равно обработан", (await bodyText()).length > 200, "символов: " + (await bodyText()).length);

    // ==================== C. чужой сервис без ключа ====================
    // Ключ обязателен только для чужого сервиса, и это тоже должно быть видно
    // на странице, а не только в коде: иначе «AI выключен» выглядело бы как
    // «локальная модель не годится». Адрес берём заведомо чужой и без права
    // доступа — если бы отказ сломали, запрос не ушёл бы в настоящий OpenAI,
    // а упёрся в права. То, что до запроса дело не доходит вовсе, проверяет
    // юнит-набор («чужой сервис без ключа: отказ до запроса»).
    console.log("\n=== C. чужой сервис без ключа: отказ и встроенный рерайтер ===");
    await setSettings({ aiBaseUrl: "https://api.example.com/v1", aiKey: "", preview: false });
    seen.length = 0;
    await openPage();
    await selectBody();
    const cc = await runAndWatch(8000);
    check("чужой сервис без ключа назван в уведомлении", /API-ключ/.test(cc.toast), oneLine(cc.toast) || "тоста нет");
    check("и здесь текст статьи обработан", (await bodyText()).length > 200);

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    check("на страницах нет исключений", errs.length === 0, errs.length ? JSON.stringify(errs[0].params).slice(0, 200) : "");
  } finally {
    try { execSync("taskkill /F /T /PID " + chrome.pid, { stdio: "ignore" }); } catch (e) {}
    try { server.close(); } catch (e) {}
    const bad = results.filter((r) => !r.ok);
    console.log("");
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e && e.message); process.exit(1); });
