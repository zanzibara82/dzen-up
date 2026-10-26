/**
 * Браузерный набор забора текста по адресу.
 *
 *   node test-source.cjs [путь-к-папке-расширения]
 *
 * Две половины одной функции, проверенные в настоящем Chrome.
 *
 * 1. Извлечение (разделы 1–4). Функция `extractArticle` выполняется В МИРЕ
 *    СТРАНИЦЫ, поэтому проверяется ровно так — вырезанной из background.js и
 *    вызванной на настоящем DOM. Разметку «как на сайте» играют моки: статья в
 *    article, статья в main с блоком content, страница без разметки вообще и
 *    заглушка антибота.
 *
 * 2. Панель и весь поток (раздел 5): поле адреса, кнопка «Взять текст»,
 *    предпросмотр «до → после», вставка выделением, ошибки и отмена. Здесь
 *    работает само расширение: грузим папку, которую передали (по умолчанию
 *    собранную), и открываем мок редактора.
 *
 * Таймаут, порог длины и закрытие вкладки на любом исходе — в юнит-наборе
 * test-fetch.cjs: там они не зависят от скорости машины.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const MOCK_DIR = PATHS.MOCK_DIR;
const USER_DATA = PATHS.testProfile("source");
const TEST_EXT = path.join(PATHS.SCRATCH, "test-ext-source");
const PORT_HTTP = 8794;
const CHROME = PATHS.CHROME;

// Проверяем ту папку, которая поедет в Chrome: иначе набор молча тестировал бы
// исходники, пока собранная копия лежит старая.
const EXT_DIR = PATHS.normalize(process.argv[2] || PATHS.EXT);
const SRC = path.join(EXT_DIR, "background.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}

/**
 * Текст одной функции из background.js. Берём до первой строки, где `}` стоит в
 * начало строки: в этом файле так заканчивается любой верхнеуровневый блок, а
 * вложенные скобки всегда с отступом. Функция обязана быть самодостаточной — она
 * и на настоящей странице живёт одна, без воркерных помощников.
 */
function sliceFunction(src, name) {
  const start = src.indexOf("\nfunction " + name + "(");
  if (start < 0) return null;
  const end = src.indexOf("\n}\n", start);
  if (end < 0) return null;
  return src.slice(start + 1, end + 2);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Копия расширения с правом на наш мок-сервер. ВАЖНО: право даётся ровно на
 * `localhost`, поэтому тот же самый мок по адресу `127.0.0.1` остаётся закрытым
 * для впрыскивания — так проверяется путь «нет права на хост», не трогая
 * настоящие сайты.
 */
function prepareTestExtension() {
  copyDir(EXT_DIR, TEST_EXT);
  const mf = path.join(TEST_EXT, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  const origin = `http://localhost:${PORT_HTTP}/*`;
  (m.content_scripts || []).forEach((cs) => {
    if (!cs.matches.includes(origin)) cs.matches.push(origin);
  });
  m.host_permissions = (m.host_permissions || []).concat([origin]);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  return TEST_EXT;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    // «вечно грузящаяся» страница для проверки отмены: ответ не закрываем вовсе
    if (url.indexOf("mock-source-hang") >= 0) return;
    const file = path.join(MOCK_DIR, url === "/" ? "mock.html" : url.split("?")[0]);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("нет такого мока"); return; }
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
      }
    }
  });

  return {
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        const payload = sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params };
        toBrowser.write(JSON.stringify(payload) + "\0");
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); rej(new Error("нет ответа на " + method)); }
        }, 25000);
      }),
  };
}

function killChrome(child) {
  if (!child) return;
  try { execSync("taskkill /F /T /PID " + child.pid, { stdio: "ignore" }); } catch (e) {}
}

/** Сколько фоновых вкладок с таким адресом осталось открыто. */
async function tabsLike(c, needle) {
  const { targetInfos } = await c.send("Target.getTargets");
  return targetInfos.filter((t) => String(t.url || "").includes(needle) && t.type === "page").length;
}

/**
 * Сколько в браузере вообще открытых страниц. Нужно для «вечно грузящейся»
 * вкладки: пока ответ не пришёл, адрес в таргете ещё не закоммичен и по нему
 * вкладку не найти — считаем по количеству.
 */
async function countPages(c) {
  const { targetInfos } = await c.send("Target.getTargets");
  return targetInfos.filter((t) => t.type === "page").length;
}

/** Те же страницы списком — провалившаяся проверка по отмене должна быть читаемой. */
async function pagesList(c) {
  const { targetInfos } = await c.send("Target.getTargets");
  return targetInfos
    .filter((t) => t.type === "page")
    .map((t) => String(t.url || "").slice(0, 60) || "(без адреса)")
    .join(" · ");
}

/**
 * Панель на странице мока-редактора. Все действия идут через мышь и клавиатуру:
 * проверка обязана ловить то, что видит человек, — в том числе потерю фокуса и
 * потерю выделения, на которых редактор Дзена и ломается.
 */
async function openEditor(c, url) {
  const { targetId } = await c.send("Target.createTarget", { url });
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  await c.send("Runtime.enable", {}, sessionId);
  await c.send("Page.enable", {}, sessionId);

  const evalJs = async (expression) => {
    const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };

  const readUi = () =>
    evalJs(`(document.querySelector('#dzr-bar .dzr-status')||{}).textContent + ' | ' + ((document.getElementById('dzr-toast')||{}).textContent||'')`);

  // Ждём панель И готовность настроек: до ответа фона панель живёт на значениях
  // по умолчанию, и поле адреса было бы пустым не потому, что его не сохранили.
  const waitPanel = async () => {
    for (let i = 0; i < 80; i++) {
      const ready = await evalJs(
        "!!document.getElementById('dzr-bar') && document.documentElement.getAttribute('data-dzr-settings') === 'ready'"
      );
      if (ready) return true;
      await sleep(150);
    }
    return false;
  };
  if (!(await waitPanel())) throw new Error("панель не появилась на " + url);

  const at = async (sel) =>
    evalJs(`(() => {
      const b = document.querySelector(${JSON.stringify(sel)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);

  const click = async (sel) => {
    // Свёрнутая в пузырёк панель держит строку адреса с нулевым размером, и
    // клик по её координатам ушёл бы в угол страницы. Ждём раскладки.
    let p = null;
    for (let i = 0; i < 80; i++) {
      const r = await at(sel);
      if (r && r.w > 0 && r.h > 0) { p = r; break; }
      await sleep(150);
    }
    if (!p) throw new Error("элемент " + sel + " не разложен");
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none" }, sessionId);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 }, sessionId);
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 }, sessionId);
  };

  const key = async (k, code, vk, modifiers) => {
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers }, sessionId);
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers }, sessionId);
  };

  return {
    evalJs,
    waitPanel,
    click,
    type: (text) => c.send("Input.insertText", { text }, sessionId),
    selectAllField: () => key("a", "KeyA", 65, 2),
    value: (sel) => evalJs(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.value:null})()`),
    textOf: (sel) => evalJs(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent:null})()`),
    htmlOf: (sel) => evalJs(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.innerHTML:null})()`),
    hasEl: (sel) => evalJs(`!!document.querySelector(${JSON.stringify(sel)})`),
    bodyText: () => evalJs(`document.querySelector('.body').innerText`),
    selectionText: () => evalJs(`String(window.getSelection())`),
    readUi,
    /** Ждём, пока в статусе или в уведомлении появится нужная фраза. */
    waitMessage: async (re) => {
      for (let i = 0; i < 80; i++) {
        const t = await readUi();
        if (re.test(t || "")) return t;
        await sleep(150);
      }
      return readUi();
    },
    waitLabel: async (sel, re) => {
      for (let i = 0; i < 60; i++) {
        const t = await evalJs(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent:''})()`);
        if (re.test(t || "")) return t;
        await sleep(150);
      }
      return "";
    },
    reload: async (u) => {
      await c.send("Page.navigate", { url: u }, sessionId);
      return waitPanel();
    },
    close: () => c.send("Target.closeTarget", { targetId })
  };
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error("Нет файла " + SRC + ". Передайте путь к папке расширения первым аргументом.");
    process.exit(1);
  }
  // Границы функции режутся по переводу строки, поэтому переводы строк нормалуем:
  // на копии с другим видом перевода вырезание иначе перестало бы работать молча.
  const srcText = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");
  const extract = sliceFunction(srcText, "extractArticle");
  const minMatch = /const SOURCE_MIN_CHARS\s*=\s*(\d+)/.exec(srcText);
  const MIN_CHARS = minMatch ? Number(minMatch[1]) : null;

  console.log("=== 0: функция извлечения есть в коде ===");
  check("в background.js найден extractArticle", !!extract, extract ? extract.length + " знаков" : "не вырезается");
  check("порог длины SOURCE_MIN_CHARS объявлен", MIN_CHARS !== null, "SOURCE_MIN_CHARS = " + MIN_CHARS);
  if (!extract || MIN_CHARS === null) {
    report();
    return;
  }

  const server = await startServer();
  prepareTestExtension();
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
    // --------------------------------------------------- 1..4: извлечение ---
    /** Открывает мок и возвращает, что на нём нашёл extractArticle. */
    const grab = async (page, before) => {
      const { targetId } = await c.send("Target.createTarget", { url: `http://127.0.0.1:${PORT_HTTP}/${page}` });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      await c.send("Runtime.enable", {}, sessionId);
      const evalJs = async (expression) => {
        const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error(page + ": " + JSON.stringify(r.exceptionDetails).slice(0, 300));
        return r.result.value;
      };
      // Ждём СОСТОЯНИЯ, а не секунды: сразу после attach документ ещё может быть
      // пустой страницей до перехода, и её готовность тоже «complete» — проверка
      // тогда читает не мок, а ничего, и провал выглядит как ошибка извлечения.
      const want = "/" + page;
      let loaded = false;
      for (let i = 0; i < 60 && !loaded; i++) {
        loaded = await evalJs(`typeof document !== "undefined" && document.readyState === "complete" && location.pathname === ${JSON.stringify(want)}`);
        if (!loaded) await sleep(100);
      }
      if (!loaded) throw new Error(page + ": страница не дошла до конца загрузки");
      if (before) await evalJs(before);
      const found = await evalJs(
        "(() => { " + extract + "\n const r = extractArticle();" +
        " return r ? { html: String(r.html || ''), title: r.title == null ? null : String(r.title), chars: r.chars } : null; })()"
      );
      await c.send("Target.closeTarget", { targetId });
      return found;
    };

    const has = (r, needle) => !!r && r.html.includes(needle);
    const lacks = (r, needle) => !!r && !r.html.includes(needle);
    const count = (r, re) => (r ? (r.html.match(re) || []).length : 0);

    console.log("=== 1: обычная страница с article ===");
    const a = await grab("mock-source-article.html");
    check("текст статьи найден", !!a, a ? "" : "extractArticle вернул пустое");
    check("заголовок взят из h1", !!a && a.title === "Как выбрать кроссовер для города", a && JSON.stringify(a.title));
    check("первый абзац на месте", has(a, "клиренс важнее полного привода"));
    check("жирный сохранён тегом", has(a, "<strong>") && has(a, "клиренс важнее"));
    check("курсив сохранён тегом", has(a, "<em>угол въезда</em>"));
    check("ссылка осталась ссылкой", has(a, '<a href="https://auto-dom24.ru/obzor-kladka"'));
    // Относительный адрес чужой страницы после вставки повёл бы в домен редактора,
    // поэтому забор обязан превратить его в полный.
    check("относительная ссылка стала полной", has(a, '<a href="http://127.0.0.1:' + PORT_HTTP + '/otzyvy/suv"'));
    check("абзацы не слиплись в одну строку", count(a, /<p[ >]/g) >= 5, "абзацев: " + count(a, /<p[ >]/g));
    for (const [tag, needle] of [
      ["шапка", "МЕНЮ-ШАПКА"], ["меню", "МЕНЮ-НАВ"], ["подвал", "ПОДВАЛ:"],
      ["боковая колонка", "БОКОВАЯ КОЛОНКА"], ["форма", "ФОРМА:"],
      ["комментарии", "КОММЕНТАРИИ:"], ["похожие материалы", "ПОХОЖЕЕ:"], ["текст скрипта", "СКРИПТ-ТЕКСТ"]
    ]) {
      check("мусор страницы не забран: " + tag, lacks(a, needle));
    }
    check("статья длиннее порога", !!a && a.chars >= MIN_CHARS, "знаков: " + (a && a.chars));
    check("считаны знаки текста, а не разметки", !!a && a.chars < a.html.length, "текст " + (a && a.chars) + " против разметки " + (a && a.html.length));

    // Забранный код живёт потом в карточке предпросмотра и вклеивается в чужую
    // страницу, поэтому с исходника должны доехать только слова и абзацы.
    console.log("=== 1б: чужой код не едет в редактор ===");
    check("обработчики событий вырезаны", !!a && !/\son(click|error|mouseover|load)\s*=/i.test(a.html), a ? JSON.stringify((a.html.match(/<[^>]*on\w+="[^"]*"[^>]*>/i) || ["нет"])[0]) : "");
    check("чужие классы вырезаны", !!a && !/\sclass\s*=/i.test(a.html));
    check("стилей из чужой страницы нет", !!a && !/\sstyle\s*=/i.test(a.html));
    check("картинки чужого сайта не забраны", !!a && !/<img/i.test(a.html));
    check("неизвестный тег разобрался, текст остался", !!a && !/<custom-tag-x/i.test(a.html) && has(a, "тег, которого в статье быть не должно"));
    check("текст абзаца с картинкой сохранён", has(a, "не должны уехать в редактор"));
    check("жирный после зачистки жив", has(a, "<strong>клиренс важнее полного привода</strong>"));
    check("ссылка после зачистки жива", has(a, '<a href="https://auto-dom24.ru/obzor-kladka"'));
    // Схема ссылки тоже приходит с чужой страницы: data: и vbscript: — не
    // ссылки статьи, а мусор, который в редакторе Дзена не нужен.
    check("data-ссылка вырезана", !!a && !/href="data:/i.test(a.html));
    check("vbscript-ссылка вырезана", !!a && !/href="vbscript:/i.test(a.html));
    check("текст ссылок-мусора остался", has(a, "data-ссылка") && has(a, "vbscript-ссылка"));

    console.log("=== 2: нет article, есть main с блоком content ===");
    const m = await grab("mock-source-main.html");
    check("текст статьи найден", !!m, m ? "" : "extractArticle вернул пустое");
    check("взят блок внутри main", has(m, "дизель живёт не до пробега"));
    check("промо-блок вне main не забран", lacks(m, "ПРОМО-БЛОК"));
    check("комментарии не забраны", lacks(m, "КОММЕНТАРИИ:"));
    check("шапка и подвал не забраны", lacks(m, "ШАПКА:") && lacks(m, "ПОДВАЛ:"));
    check("ссылка сохранена", has(m, '<a href="https://auto-dom24.ru/dvigatel"'));
    check("заголовок взят из title страницы", !!m && m.title === "Обзор дизеля: что остаётся после гарантии — Мок сайта", m && JSON.stringify(m.title));

    console.log("=== 3: ни article, ни main — берём самый крупный блок ===");
    const l = await grab("mock-source-largest.html");
    check("текст статьи найден", !!l, l ? "" : "extractArticle вернул пустое");
    check("взят крупный текстовый блок", has(l, "единственный ориентир"));
    check("акценты внутри него сохранены", has(l, "<strong>блок с текстом заметно больше</strong>"));
    check("ссылка сохранена", has(l, '<a href="https://auto-dom24.ru/obzor"'));
    check("меню не забрано", lacks(l, "МЕНЮ:"));
    check("хлебные крошки не забраны", lacks(l, "Хлебные крошки:"));
    check("рекламный баннер не забран", lacks(l, "РЕКЛАМА:"));
    check("подвал блока не забран", lacks(l, "ПОДВАЛ БЛОКА"));

    // Заглушка: проверка на то, что в редактор несут ровно столько, сколько
    // нашли. Догрузку включает сам набор, а не таймер страницы: иначе проверка
    // зависела бы от скорости машины.
    console.log("=== 4: страница-заглушка и догруженный контент ===");
    const s = await grab("mock-source-stub.html");
    check("заглушка найдена, но короткая", !!s && s.chars < MIN_CHARS, s ? "знаков: " + s.chars : "пустое");
    check("в заглушке нет догруженной статьи", lacks(s, "Догруженный первый абзац"));
    const s2 = await grab("mock-source-stub.html", "window.dzrRelease()");
    check("после догрузки текст стал статьёй", !!s2 && s2.chars >= MIN_CHARS, s2 ? "знаков: " + s2.chars : "пустое");
    check("догруженный абзац забран", has(s2, "Догруженный первый абзац"));
    check("разметка догруженного абзаца цела", has(s2, "<strong>текст появился только после скрипта</strong>"));

    // ------------------------------------------------ 5: панель и весь поток ---
    console.log("=== 5: поле адреса, предпросмотр, вставка, ошибки, отмена ===");
    let extId = null;
    for (let i = 0; i < 40; i++) {
      try { extId = (await c.send("Extensions.loadUnpacked", { path: TEST_EXT })).id; break; }
      catch (e) { if (i === 39) throw e; await sleep(400); }
    }
    await PATHS.clearStorage(c, extId, TEST_EXT);

    const EDITOR_URL = `http://localhost:${PORT_HTTP}/mock.html`;
    const page = await openEditor(c, EDITOR_URL);

    const SRC_INPUT = "#dzr-bar .dzr-src-url";
    const SRC_BTN = "#dzr-bar .dzr-src-btn";

    check("в панели есть поле адреса", await page.hasEl(SRC_INPUT));
    const label = await page.textOf(SRC_BTN);
    check("в панели есть кнопка «Взять текст»", /Взять текст/.test(label || ""), JSON.stringify(label));

    // набор как человек: клик по полю, затем ввод через отладочный канал.
    // Протокол пишем прямо: голый хост воркер по правилам дотягивает до
    // «https://», а наш мок-сервер живёт на простом http.
    await page.click(SRC_INPUT);
    await page.type("http://localhost:" + PORT_HTTP + "/mock-source-article.html");
    const typed = await page.value(SRC_INPUT);
    check("введённый адрес остался в поле", /mock-source-article\.html$/.test(typed || ""), JSON.stringify(typed));

    await page.click(SRC_BTN);
    let previewOpen = false;
    for (let i = 0; i < 80 && !previewOpen; i++) {
      previewOpen = await page.hasEl("#dzr-preview");
      if (!previewOpen) await sleep(150);
    }
    check("после забора открылся предпросмотр", previewOpen, await page.readUi());
    const pvText = await page.textOf("#dzr-preview .dzr-pv-body");
    const pvHtml = await page.htmlOf("#dzr-preview .dzr-pv-body");
    check("в предпросмотре — текст чужой статьи", /клиренс важнее полного привода/.test(pvText || ""), JSON.stringify(String(pvText || "").slice(0, 70)));
    check("в предпросмотре разметка цела", /<strong>клиренс важнее полного привода<\/strong>/.test(pvHtml || ""), JSON.stringify(String(pvHtml || "").slice(0, 70)));
    const before = await page.bodyText();
    check("статья в редакторе ещё не изменена", !/клиренс важнее/.test(before), JSON.stringify(before.slice(0, 60)));
    check("фоновая вкладка закрыта после забора", (await tabsLike(c, "mock-source-article")) === 0);

    await page.click("#dzr-preview .dzr-pv-apply");
    let inserted = false;
    for (let i = 0; i < 80 && !inserted; i++) {
      inserted = /клиренс важнее полного привода/.test(await page.bodyText());
      if (!inserted) await sleep(150);
    }
    check("«Применить» вставило забранный текст", inserted, JSON.stringify((await page.bodyText()).slice(0, 70)));
    // Собственное поле панели — тоже поле ввода: если findEditor примет его за
    // редактор статьи, забранный текст уедет туда, а человек увидит пустую статью.
    check("текст не уехал в поле адреса", !/клиренс важнее/.test((await page.value(SRC_INPUT)) || ""), String(await page.value(SRC_INPUT)).slice(0, 80));
    const sel = await page.selectionText();
    check("вставленный текст стал выделением", /клиренс важнее/.test(sel || ""), JSON.stringify(String(sel || "").slice(0, 70)));

    // Откат забора: «оригинала» у забранного текста нет, поэтому обещать
    // копирование в буфер обмена тост не имеет права.
    const UNDO = '#dzr-bar .dzr-icon-btn[title*="Отменить вставку"]';
    check("после вставки появилась кнопка отката", (await page.hasEl(UNDO)) && !(await page.evalJs(`document.querySelector(${JSON.stringify(UNDO)}).hidden`)));
    await page.click(UNDO);
    const undoMsg = await page.waitMessage(/Вставка отменена/);
    check("откат убрал вставленный текст", !/клиренс важнее/.test(await page.bodyText()), JSON.stringify((await page.bodyText()).slice(0, 60)));
    check("тост отката не обещает буфер обмена", !/Оригинал скопирован/.test(undoMsg || ""), JSON.stringify(String(undoMsg).slice(0, 110)));
    // нативный undo в Chrome идёт по истории документа и стирает ввод в поле
    // адреса — после отката адрес обязан остаться на месте
    check("откат не стёр адрес статьи", /mock-source-article\.html$/.test((await page.value(SRC_INPUT)) || ""), JSON.stringify(await page.value(SRC_INPUT)));

    // значение живёт в настройках: и после сворачивания в пузырёк, и после
    // перезагрузки страницы. Ждём СМЕНЫ РАСКЛАДКИ после каждого клика: кнопка
    // в пути анимации уезжает, и второй клик иначе уходит мимо.
    const fieldLaidOut = () =>
      page.evalJs(
        `(() => { var e = document.querySelector('#dzr-bar .dzr-src-url'); if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`
      );
    await page.click("#dzr-bar .dzr-toggle");
    for (let i = 0; i < 40 && (await fieldLaidOut()); i++) await sleep(150);
    check("сворачивание в пузырёк скрыло поле адреса", !(await fieldLaidOut()));
    await page.click("#dzr-bar .dzr-toggle");
    for (let i = 0; i < 40 && !(await fieldLaidOut()); i++) await sleep(150);
    check("адрес пережил сворачивание в пузырёк", /mock-source-article\.html$/.test((await page.value(SRC_INPUT)) || ""), await page.value(SRC_INPUT));
    await page.reload(EDITOR_URL);
    check("адрес пережил перезагрузку страницы", /mock-source-article\.html$/.test((await page.value(SRC_INPUT)) || ""), await page.value(SRC_INPUT));

    // ---- ошибки: человек должен понять, что нажать, а не гадать ----
    await page.click(SRC_INPUT);
    await page.selectAllField();
    await page.type("это не адрес");
    await page.click(SRC_BTN);
    const errBad = await page.waitMessage(/адрес/i);
    check("мусорный адрес назван мусорным", /адрес/i.test(errBad || ""), JSON.stringify(String(errBad).slice(0, 90)));
    check("мусорный адрес: фоновая вкладка не открыта", (await tabsLike(c, "mock-source")) === 0);

    // Право на http выдано только localhost и 127.0.0.1, поэтому прочий http
    // обязан отсекаться до открытия вкладки — иначе человек получит подсказку
    // «Разрешить доступ», которая ничего не разрешит.
    await page.click(SRC_INPUT);
    await page.selectAllField();
    await page.type("http://example.com/mock-source-article.html");
    await page.click(SRC_BTN);
    const errHttp = await page.waitMessage(/только по https/i);
    check("http вне localhost объяснён схемой", /только по https/i.test(errHttp || ""), JSON.stringify(String(errHttp).slice(0, 110)));
    check("http вне localhost: вкладка не открыта", (await tabsLike(c, "example.com")) === 0);

    await page.click(SRC_INPUT);
    await page.selectAllField();
    await page.type("http://127.0.0.1:" + PORT_HTTP + "/mock-source-article.html");
    await page.click(SRC_BTN);
    const errPerm = await page.waitMessage(/Разрешить доступ/i);
    check("без права на хост подсказано, что нажать", /«Разрешить доступ к сайтам»/.test(errPerm || ""), JSON.stringify(String(errPerm).slice(0, 120)));
    check("без права на хост: фоновая вкладка закрыта", (await tabsLike(c, "mock-source-article")) === 0);

    await page.click(SRC_INPUT);
    await page.selectAllField();
    await page.type("http://localhost:" + PORT_HTTP + "/mock-source-stub.html");
    await page.click(SRC_BTN);
    const errStub = await page.waitMessage(/не статья|похоже/i);
    check("заглушка названа не статьёй", /не статья|похоже/i.test(errStub || ""), JSON.stringify(String(errStub).slice(0, 120)));
    check("заглушка: фоновая вкладка закрыта", (await tabsLike(c, "mock-source-stub")) === 0);

    // ---- отмена: страница грузится вечно, человек передумал ----
    await page.click(SRC_INPUT);
    await page.selectAllField();
    await page.type("http://localhost:" + PORT_HTTP + "/mock-source-hang.html");
    const basePages = await countPages(c);
    await page.click(SRC_BTN);
    const busyLabel = await page.waitLabel(SRC_BTN, /Отменить/);
    check("во время забора кнопка предлагает отмену", /Отменить/.test(busyLabel || ""), JSON.stringify(busyLabel));
    // кнопка «Отменить» появляется раньше вкладки: воркер создаёт её отдельным
    // шагом, поэтому ждём состояние, а не меряем сразу после подписи
    let opened = false;
    for (let i = 0; i < 60 && !opened; i++) {
      opened = (await countPages(c)) === basePages + 1;
      if (!opened) await sleep(150);
    }
    check("вечная вкладка открыта и ждёт", opened, "страниц: " + (await countPages(c)) + ", ждали " + (basePages + 1) + " — " + (await pagesList(c)));
    await page.click(SRC_BTN);
    let gone = false;
    for (let i = 0; i < 60 && !gone; i++) {
      gone = (await countPages(c)) === basePages && (await tabsLike(c, "mock-source-hang")) === 0;
      if (!gone) await sleep(150);
    }
    check("отмена закрыла фоновую вкладку", gone, "страниц осталось: " + (await countPages(c)));
    const cancelled = await page.waitMessage(/отмен/i);
    check("отмена названа отменой", /отмен/i.test(cancelled || ""), JSON.stringify(String(cancelled).slice(0, 90)));
  } finally {
    killChrome(chrome);
    try { server.close(); } catch (e) {}
    report();
  }
}

function report() {
  const failed = results.filter((r) => !r.ok).length;
  console.log("");
  console.log("всего проверок: %d, провалов: %d", results.length, failed);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error("ОШИБКА ТЕСТА:", (e && e.stack) || e);
  process.exit(1);
});
