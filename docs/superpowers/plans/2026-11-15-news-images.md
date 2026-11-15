# Подбор изображений для новости — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Кнопка «Изображения» на панели Дзена открывает окно, которое по заголовку статьи находит картинки в Bing и Яндексе, скачивает 5–10 штук не тяжелее 3 МБ в `<папка установки>/news/<заголовок>/` и показывает прогресс.

**Architecture:** Панель — контент-скрипт: у неё нет рукояти папки и права просить доступ к чужим сайтам. Поэтому панель только отправляет фону заголовок; фон открывает (или фокусирует) окно `images.html` на происхождении расширения. Окно само читает рукоять папки установки из IndexedDB (та же, что у автообновления), просит права, ищет и пишет файлы через File System Access API. Чистые функции разбора и имён вынесены в `images.js` и проверяются юнит-набором без браузера.

**Tech Stack:** Chrome MV3, vanilla JS (ES5-стиль в существующем коде), `chrome.windows`, `chrome.storage.session`, `chrome.permissions`, File System Access API, IndexedDB, `fetch` + `AbortController`, SHA-256 через `crypto.subtle`.

**Spec:** `docs/superpowers/specs/2026-11-15-news-images-design.md` (закоммичена как `efb8b42`).

## Global Constraints

- Весь текст — по-русски: код, комментарии, документация, сообщения. Без иероглифов и без склейки кириллицы с латиницей внутри слова.
- API-ключи пользователя никогда не попадают в файлы, коммиты, логи, статистику и в текст статьи — только в хранилище браузера или переменную окружения. Окно картинок ключ AI не читает и в сообщениях не передаёт.
- Ветка `main`; коммиты только через `git -c user.name="zanzibara82" -c user.email="294739332+zanzibara82@users.noreply.github.com" commit ...`. Пуш в `main` разрешён, force-push — нет. Пустых коммитов не создавать.
- Сборка только `node tools/build-extension.cjs` (git archive даёт CRLF и ломает набор `docs`).
- Каждая правка поведения — через RED→GREEN: сначала падающий тест, затем код. После правки — частичный прогон; перед сдачей — полный прогон всех 22 наборов.
- Браузерные наборы ревьюеров не запускать.
- Тестовые профили Chrome не давать расти; неудаляемый остаток докладывать путём и размером.
- После каждого своего прогона чистить `%TEMP%` (только свои файлы и профили); сервер моков убивать заранее.
- Новых прав в манифесте нет: `https://*/*` уже лежит в `optional_host_permissions`.
- Окно картинок скачивает только `https:`-адреса (право выдано на `https://*/*`), хотя `isHttpUrl` принимает и `http:` — это проверка разбора выдачи, а не разрешение на загрузку.
- Чужой HTML не вставляется в страницу: выдачи разбираются как текст, имена и заголовки выводятся через `textContent`, не через `innerHTML`.
- Потолок одной картинки — `3 * 1024 * 1024` байт; число фото — 5–10, по умолчанию 8; источники — Bing и Яндекс; `news` в zip не попадает.

---

## Структура файлов

| Файл | Ответственность |
| --- | --- |
| `src/extension-src/images.js` (создать) | Чистые функции: границы, разбор Bing/Яндекса, склейка, имена папок и файлов, сигнатуры, заголовок. Ни `chrome`, ни DOM-записи. |
| `src/extension-src/images.html` (создать) | Разметка окна подбора и встроенные стили. |
| `src/extension-src/images-page.js` (создать) | Логика окна: права, поиск, пул загрузок, запись в папку, статусы, отмена. |
| `src/extension-src/update.js` (изменить) | Сюда переезжают помощники рукояти папки (`openUpdateDb`, `withUpdateStore`, `saveDirHandle`, `loadDirHandle`, `forgetDirHandle`). |
| `src/extension-src/popup.js` (изменить) | Берёт помощники рукояти из `DzenUpdate`; сохраняет и читает `imageCount`. |
| `src/extension-src/popup.html` (изменить) | Поле `#imageCount`, подключение `images.js`. |
| `src/extension-src/background.js` (изменить) | `DEFAULTS.imageCount`, сообщение `openImagePicker`, окно-одиночка в `chrome.storage.session`. |
| `src/extension-src/content.js` (изменить) | Иконка `image`, кнопка `imagesBtn`, отправка заголовка фону. |
| `src/extension-src/content.css` (изменить) | Вид кнопки в обычной, свёрнутой и вертикальной панели. |
| `src/extension-src/manifest.json` (изменить) | `images.js` в `content_scripts`, `options_ui.page = images.html`, версия 2.4.0. |
| `tools/build-extension.cjs` (изменить) | Новые файлы в `FILES`; сохранение `<out>/news` при пересборке. |
| `test/test-reliability.cjs` (изменить) | Разделы 29 (состав), 33 (чистые функции), 34 (рукоять), 35 (news при сборке); подставной `chrome.windows`. |
| `test/test-popup.cjs` (изменить) | Браузерный блок окна подбора. |
| `test/test-ui.cjs` (изменить) | Кнопка панели открывает окно с заголовком. |
| `test/test-docs.cjs` (изменить) | Сторожа: настройка, состав, `options_ui`, версия, README. |
| `src/extension-src/README.md` (изменить) | Раздел «Подбор изображений», строка таблицы настроек, версия 2.4.0. |

## Общие интерфейсы

`images.js` выставляет глобальный объект `DzenImages`:

```js
{
  MIN_COUNT: 5, MAX_COUNT: 10, DEFAULT_COUNT: 8,
  MAX_IMAGE_BYTES: 3145728, MAX_CANDIDATES: 40,
  clampCount(value) -> number,
  decodeEntities(text) -> string,
  parseBing(html) -> string[],
  parseYandex(html) -> string[],
  isHttpUrl(url) -> boolean,
  mergeCandidates(lists, limit) -> string[],
  sanitizeFolderName(title, fallback) -> string,
  nextFreeName(base, used) -> string,
  imageType(bytes) -> "jpg" | "png" | "gif" | "webp" | null,
  fileName(index, ext) -> string,
  guessTitle(doc, editor) -> string
}
```

`update.js` дополнительно отдаёт: `openUpdateDb()`, `withUpdateStore(mode, fn)`, `saveDirHandle(handle)`, `loadDirHandle()`, `forgetDirHandle()`.

Фон отвечает на `{ type: "openImagePicker", title }` объектом `{ ok: true, windowId, reused }` либо `{ ok: false, error }`.

---

## Task 1: `images.js` — чистые функции подбора

**Files:**
- Create: `src/extension-src/images.js`
- Test: `test/test-reliability.cjs` (новый раздел 33 перед `=== ИТОГ ===`)

**Interfaces:**
- Consumes: ничего, модуль самодостаточен.
- Produces: `DzenImages` с именами из раздела «Общие интерфейсы». Дальше его используют `content.js`, `popup.js`, `images-page.js` и юнит-набор.

- [ ] **Step 1: Написать падающий тест (раздел 33)**

Вставить перед строкой `console.log("\n=== ИТОГ ===");` в `test/test-reliability.cjs`:

```js
  console.log("\n=== 33. подбор картинок: разбор выдач и имена ===");
  {
    // Модуль отдельно от окна: разбор чужого HTML и очистка имён — это то, что
    // ломается тихо (пустая выдача выглядит как «ничего не нашлось») и что нельзя
    // проверить живым кликом без сети. Грузим ту же копию, что попадёт в пакет.
    const imgPath = path.join(PATHS.REPO, "src", "extension-src", "images.js");
    let img = null;
    let imgErr = "";
    try {
      img = new Function(fs.readFileSync(imgPath, "utf8") + "\nreturn DzenImages;")();
    } catch (e) {
      imgErr = String((e && e.message) || e);
    }
    check("images.js отдаёт модуль DzenImages", !!img && typeof img.guessTitle === "function", imgErr);

    if (img) {
      check("границы настройки: 5–10, по умолчанию 8",
        img.MIN_COUNT === 5 && img.MAX_COUNT === 10 && img.DEFAULT_COUNT === 8,
        JSON.stringify({ min: img.MIN_COUNT, max: img.MAX_COUNT, def: img.DEFAULT_COUNT }));
      check("потолок картинки — 3 МБ", img.MAX_IMAGE_BYTES === 3 * 1024 * 1024, String(img.MAX_IMAGE_BYTES));

      const bingBoth = '{"murl":"https://a.test/1.jpg"} {"murl&quot;:&quot;https://a.test/2.jpg?x=1&amp;y=2&quot;}';
      check("Bing: обе формы кавычек и &amp;",
        JSON.stringify(img.parseBing(bingBoth)) === JSON.stringify(["https://a.test/1.jpg", "https://a.test/2.jpg?x=1&y=2"]),
        JSON.stringify(img.parseBing(bingBoth)));
      const yandexBoth = '{"origUrl":"https://b.test/1.png"} {"origUrl&quot;:&quot;https://b.test/2.png&quot;}';
      check("Яндекс: обе формы кавычек",
        JSON.stringify(img.parseYandex(yandexBoth)) === JSON.stringify(["https://b.test/1.png", "https://b.test/2.png"]),
        JSON.stringify(img.parseYandex(yandexBoth)));
      check("пустая выдача — пустой список", img.parseBing("").length === 0 && img.parseYandex(null).length === 0);

      check("&quot; и &#x2F; раскодированы",
        img.decodeEntities("&quot;a&#x2F;b&quot; &amp; &#34;c&#34;") === '"a/b" & "c"',
        img.decodeEntities("&quot;a&#x2F;b&quot; &amp; &#34;c&#34;"));

      const merged = img.mergeCandidates([["https://a.test/1", "https://a.test/2"], ["https://b.test/3", "https://a.test/1"]], 10);
      check("склейка идёт по очереди источников и без дублей",
        JSON.stringify(merged) === JSON.stringify(["https://a.test/1", "https://b.test/3", "https://a.test/2"]),
        JSON.stringify(merged));
      const bad = img.mergeCandidates([["javascript:alert(1)", "http://a.test/x", "ftp://a.test/y", "https://user:pass@a.test/z", "https://a.test/" + "x".repeat(2048)]], 10);
      check("склейка отбрасывает недопустимые адреса",
        JSON.stringify(bad) === JSON.stringify(["http://a.test/x"]), JSON.stringify(bad));
      check("потолок склейки соблюдается",
        img.mergeCandidates([Array.from({ length: 50 }, (_, i) => "https://a.test/" + i)], 7).length === 7);

      check("имя папки: слэши и .. убраны",
        img.sanitizeFolderName("../../evil", "novost") === "evil",
        img.sanitizeFolderName("../../evil", "novost"));
      check("имя папки: служебное имя Windows обезврежено",
        img.sanitizeFolderName("CON", "novost") === "_CON", img.sanitizeFolderName("CON", "novost"));
      check("имя папки: пустое уходит в запасное",
        img.sanitizeFolderName("   ", "../../x") === "x", img.sanitizeFolderName("   ", "../../x"));
      check("длинное имя режется до 80 знаков",
        img.sanitizeFolderName("я".repeat(200), "novost").length === 80);
      check("имя папки никогда не пустое", img.sanitizeFolderName("", "") === "novost", img.sanitizeFolderName("", ""));

      check("занятое имя получает номер",
        img.nextFreeName("Тема", new Set(["Тема", "Тема (2)"])) === "Тема (3)",
        img.nextFreeName("Тема", new Set(["Тема", "Тема (2)"])));

      const sig = (bytes) => img.imageType(Uint8Array.from(bytes));
      check("сигнатуры: jpg, png, gif, webp",
        sig([0xff, 0xd8, 0xff, 0xe0]) === "jpg" &&
        sig([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) === "png" &&
        sig([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) === "gif" &&
        sig([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]) === "webp");
      check("HTML вместо картинки не принимается",
        sig(Array.from(Buffer.from("<!doctype html>"))) === null);

      check("имена файлов: 01.jpg и 10.webp",
        img.fileName(0, "jpg") === "01.jpg" && img.fileName(9, "webp") === "10.webp",
        img.fileName(9, "webp"));

      check("число фото: 4 → 5, 99 → 10, пусто → 8, мусор → 8",
        img.clampCount(4) === 5 && img.clampCount(99) === 10 && img.clampCount("") === 8 && img.clampCount("abc") === 8,
        JSON.stringify([img.clampCount(4), img.clampCount(99), img.clampCount(""), img.clampCount("abc")]));

      // Заголовок: поле «Заголовок» важнее h1 и редактора; скрытый h1 пропускаем.
      const el = (text, extra) => Object.assign({
        innerText: text,
        textContent: text,
        value: undefined,
        hidden: false,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ width: 10, height: 10 })
      }, extra || {});
      const docOf = (map) => ({
        querySelector: (s) => map[s] || null,
        querySelectorAll: () => [],
        title: map.__title || ""
      });
      const field = img.guessTitle(docOf({ '.title[contenteditable="true"]': el("  Заголовок   из поля "), __title: "Вкладка — Дзен" }), null);
      check("заголовок берётся из поля и схлопывается", field === "Заголовок из поля", field);
      const h1 = img.guessTitle({
        querySelector: () => null,
        querySelectorAll: () => [
          el("", { hidden: true }),
          el("Видимый h1")
        ],
        title: ""
      }, null);
      check("скрытый h1 пропускается, берётся видимый", h1 === "Видимый h1", h1);
      const fromEditor = img.guessTitle({ querySelector: () => null, querySelectorAll: () => [], title: "" }, el("\n\n Первая строка редактора \nвторая"));
      check("затем первая непустая строка редактора", fromEditor === "Первая строка редактора", fromEditor);
      const fromTitle = img.guessTitle({ querySelector: () => null, querySelectorAll: () => [], title: "Новость дня — Дзен" }, null);
      check("последним — заголовок вкладки без «— Дзен»", fromTitle === "Новость дня", fromTitle);
      check("«Дзен» вместо заголовка не принимается",
        img.guessTitle({ querySelector: () => null, querySelectorAll: () => [], title: "Дзен" }, null) === "");
      check("длина заголовка не больше 160",
        img.guessTitle({ querySelector: () => null, querySelectorAll: () => [], title: "я".repeat(300) }, null).length === 160);
    }
  }
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node test/test-reliability.cjs`
Expected: FAIL на `images.js отдаёт модуль DzenImages` — файла `src/extension-src/images.js` нет (`ENOENT`), остальные проверки модуля не выполняются.

- [ ] **Step 3: Создать `src/extension-src/images.js`**

```js
/* Дзен Рерайтер — подбор картинок: разбор выдач, имена и заголовок.
   Модуль без chrome и без DOM-записей: его проверяет юнит-набор, а в браузере
   он подключён и к панели, и к окну подбора, и к попапу. */
var DzenImages = (function () {
  "use strict";
  var MIN_COUNT = 5;
  var MAX_COUNT = 10;
  var DEFAULT_COUNT = 8;
  var MAX_IMAGE_BYTES = 3 * 1024 * 1024;
  var MAX_CANDIDATES = 40;
  var MAX_TITLE = 160;
  // Имена устройств Windows: папку "CON" система создать не даст.
  var WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i;

  function clampCount(value) {
    var text = String(value == null ? "" : value).trim();
    if (!/^\d+$/.test(text)) return DEFAULT_COUNT;
    var n = parseInt(text, 10);
    if (n < MIN_COUNT) return MIN_COUNT;
    if (n > MAX_COUNT) return MAX_COUNT;
    return n;
  }

  // Выдача Bing и Яндекса приходит JSON-ом внутри HTML и в двух формах кавычек:
  // обычной и &quot;. Обратный слэш перед кавычкой — третья форма.
  function decodeEntities(text) {
    return String(text == null ? "" : text)
      .replace(/&(?:quot|#34|#x22);/gi, '"')
      .replace(/&#x2F;/gi, "/")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&(?:amp|#38|#x26);/gi, "&")
      .replace(/\\\//g, "/");
  }

  function pick(html, key) {
    var re = new RegExp(key + '(?:&quot;|"|\\\\")\\s*:\\s*(?:&quot;|"|\\\\")(.*?)(?:&quot;|"|\\\\")', "g");
    var out = [];
    var m;
    while ((m = re.exec(String(html || "")))) out.push(decodeEntities(m[1]));
    return out;
  }

  function parseBing(html) {
    return pick(html, "murl");
  }

  function parseYandex(html) {
    return pick(html, "origUrl");
  }

  function isHttpUrl(url) {
    if (typeof url !== "string" || !url || url.length > 2048) return false;
    try {
      var u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      if (u.username || u.password) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function mergeCandidates(lists, limit) {
    var cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : MAX_CANDIDATES;
    cap = Math.min(cap, MAX_CANDIDATES);
    var rows = (lists || []).map(function (l) { return Array.isArray(l) ? l : []; });
    var seen = {};
    var out = [];
    var deepest = 0;
    rows.forEach(function (l) { if (l.length > deepest) deepest = l.length; });
    for (var i = 0; i < deepest && out.length < cap; i++) {
      for (var j = 0; j < rows.length && out.length < cap; j++) {
        var url = rows[j][i];
        if (!isHttpUrl(url) || seen[url]) continue;
        seen[url] = true;
        out.push(url);
      }
    }
    return out;
  }

  function cleanName(text) {
    return String(text == null ? "" : text)
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[. ]+|[. ]+$/g, "");
  }

  function sanitizeFolderName(title, fallback) {
    var name = cleanName(title);
    if (name.length > 80) name = name.slice(0, 80).replace(/[. ]+$/g, "");
    if (!name) name = cleanName(fallback).slice(0, 80);
    if (!name) name = "novost";
    if (WINDOWS_RESERVED.test(name)) name = "_" + name;
    return name;
  }

  function nextFreeName(base, used) {
    var taken = used instanceof Set ? used : new Set(used || []);
    if (!taken.has(base)) return base;
    for (var i = 2; i < 1000; i++) {
      var candidate = base + " (" + i + ")";
      if (!taken.has(candidate)) return candidate;
    }
    return base + " (" + Date.now() + ")";
  }

  function imageType(bytes) {
    if (!bytes || typeof bytes.length !== "number") return null;
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
    return null;
  }

  function fileName(index, ext) {
    var n = Math.floor(Number(index));
    if (!isFinite(n) || n < 0) n = 0;
    var tail = String(ext || "").replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
    return (n + 1 < 10 ? "0" + (n + 1) : String(n + 1)) + "." + tail;
  }

  function textOf(el) {
    if (!el) return "";
    if (el.value != null) return String(el.value);
    return String(el.innerText || el.textContent || "");
  }

  function cleanTitle(text) {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE).trim();
  }

  function titleFromField(doc) {
    if (!doc || typeof doc.querySelector !== "function") return "";
    var selectors = [
      'textarea[placeholder*="Заголовок" i]',
      'input[placeholder*="Заголовок" i]',
      '[contenteditable="true"][data-placeholder*="Заголовок" i]',
      '[contenteditable="true"][aria-label*="Заголовок" i]',
      '.title[contenteditable="true"]',
      'textarea[class*="title" i]',
      'input[class*="title" i]',
      '[data-testid*="title" i] textarea',
      '[data-testid*="title" i] input',
      '[data-testid*="title" i] [contenteditable="true"]',
      '[data-testid*="title" i]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var t = cleanTitle(textOf(doc.querySelector(selectors[i])));
      if (t) return t;
    }
    return "";
  }

  function visible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    if (typeof el.getBoundingClientRect === "function") {
      var r = el.getBoundingClientRect();
      if (r && (r.width === 0 || r.height === 0)) return false;
    }
    return true;
  }

  function guessTitle(doc, editor) {
    var t = titleFromField(doc);
    if (t) return t;
    if (doc && typeof doc.querySelectorAll === "function") {
      var h1s = doc.querySelectorAll("h1");
      for (var i = 0; i < h1s.length; i++) {
        if (!visible(h1s[i])) continue;
        t = cleanTitle(textOf(h1s[i]));
        if (t) return t;
      }
    }
    if (editor) {
      var lines = String(textOf(editor)).split(/\r?\n/);
      for (var j = 0; j < lines.length; j++) {
        t = cleanTitle(lines[j]);
        if (t) return t;
      }
    }
    if (doc && typeof doc.title === "string") {
      t = cleanTitle(doc.title.replace(/\s*[—–|-]\s*(?:Яндекс\s+)?Дзен\s*$/i, ""));
      if (t && !/^Дзен$/i.test(t)) return t;
    }
    return "";
  }

  return {
    MIN_COUNT: MIN_COUNT,
    MAX_COUNT: MAX_COUNT,
    DEFAULT_COUNT: DEFAULT_COUNT,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    MAX_CANDIDATES: MAX_CANDIDATES,
    clampCount: clampCount,
    decodeEntities: decodeEntities,
    parseBing: parseBing,
    parseYandex: parseYandex,
    isHttpUrl: isHttpUrl,
    mergeCandidates: mergeCandidates,
    sanitizeFolderName: sanitizeFolderName,
    nextFreeName: nextFreeName,
    imageType: imageType,
    fileName: fileName,
    guessTitle: guessTitle
  };
})();
```

- [ ] **Step 4: Прогнать тест до зелёного**

Run: `node test/test-reliability.cjs`
Expected: PASS, в итоге число провалов 0. Если падает `скрытый h1` — проверить, что `visible` смотрит `hidden` и нулевой прямоугольник.

- [ ] **Step 5: Коммит**

```bash
git add src/extension-src/images.js test/test-reliability.cjs
git -c user.name="zanzibara82" -c user.email="294739332+zanzibara82@users.noreply.github.com" commit -m "images.js: чистые функции подбора картинок и юнит-проверки"
```

---

## Task 2: помощники рукояти папки переезжают в `update.js`

**Files:**
- Modify: `src/extension-src/update.js` (после `function pageAssets`, до `updateFileSet`; экспорт в конце)
- Modify: `src/extension-src/popup.js:712-743, 749, 757, 835`
- Test: `test/test-reliability.cjs` (новый раздел 34 перед `=== ИТОГ ===`)

**Interfaces:**
- Consumes: `indexedDB`, имена базы/хранилища/ключа уже объявлены в `update.js`.
- Produces: `DzenUpdate.openUpdateDb`, `DzenUpdate.withUpdateStore`, `DzenUpdate.saveDirHandle`, `DzenUpdate.loadDirHandle`, `DzenUpdate.forgetDirHandle`. Ими пользуются и попап, и окно картинок.

- [ ] **Step 1: Написать падающий тест (раздел 34)**

Вставить перед `console.log("\n=== ИТОГ ===");` в `test/test-reliability.cjs` (после раздела 33):

```js
  console.log("\n=== 34. рукоять папки: помощники update.js ===");
  {
    // Рукоять — единственный ключ к папке установки, и её читают уже двое: попап
    // и окно подбора. Вторая копия имён базы и хранилища рано или поздно
    // разъехалась бы, поэтому помощники живут в update.js, а не в попапе.
    try {
      const updPath = path.join(PATHS.REPO, "src", "extension-src", "update.js");
      const mem = require("./fixtures/memory-idb.cjs");
      const upd = new Function("indexedDB", fs.readFileSync(updPath, "utf8") + "\nreturn DzenUpdate;")(mem);
      const names = ["openUpdateDb", "withUpdateStore", "saveDirHandle", "loadDirHandle", "forgetDirHandle"];
      check("update.js отдаёт помощники рукояти",
        names.every((n) => typeof upd[n] === "function"),
        names.filter((n) => typeof upd[n] !== "function").join(", "));
      const handle = { name: "dzen-rewriter", kind: "directory" };
      await upd.saveDirHandle(handle);
      check("рукоять читается той же", (await upd.loadDirHandle()) === handle);
      await upd.forgetDirHandle();
      check("рукоять забывается", (await upd.loadDirHandle()) === undefined);
    } catch (e) {
      check("помощники рукояти не роняют набор", false, String((e && e.message) || e));
    }
  }
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node test/test-reliability.cjs`
Expected: FAIL `update.js отдаёт помощники рукояти` — в списке все пять имён.

- [ ] **Step 3: Перенести помощники в `update.js`**

Вставить перед `function updateFileSet` (после `pageAssets`):

```js
  // ---------------------------------------------------------- рукоять папки ---
  // Рукоять выбранной папки установки живёт в IndexedDB: класть её в
  // chrome.storage нельзя — structured clone не переносит методы FileSystemHandle.
  // Читают её попап и окно подбора, поэтому код один и лежит здесь.
  function openUpdateDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error("не открылась IndexedDB"));
      };
    });
  }

  function withUpdateStore(mode, fn) {
    return openUpdateDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, mode);
        var req = fn(tx.objectStore(IDB_STORE));
        tx.oncomplete = function () {
          db.close();
          resolve(req ? req.result : undefined);
        };
        tx.onerror = function () {
          db.close();
          reject(tx.error || new Error("IndexedDB не приняла запись"));
        };
      });
    });
  }

  function saveDirHandle(handle) {
    return withUpdateStore("readwrite", function (s) {
      return s.put(handle, IDB_KEY);
    });
  }

  function loadDirHandle() {
    return withUpdateStore("readonly", function (s) {
      return s.get(IDB_KEY);
    });
  }

  function forgetDirHandle() {
    return withUpdateStore("readwrite", function (s) {
      return s.delete(IDB_KEY);
    });
  }
```

В возвращаемый объект (рядом с `IDB_KEY`) добавить:

```js
    openUpdateDb: openUpdateDb,
    withUpdateStore: withUpdateStore,
    saveDirHandle: saveDirHandle,
    loadDirHandle: loadDirHandle,
    forgetDirHandle: forgetDirHandle,
```

Поправить комментарий `updateFileSet`: строка «`options_ui.page` и `action.default_popup` — один файл» станет неверной после переноса на `images.html`. Заменить абзац на:

```js
   * Возвращается отсортированный набор без дублей: `options_ui.page` и
   * `action.default_popup` могут совпадать, и включать такой файл дважды незачем.
```

- [ ] **Step 4: Переключить `popup.js` на `DzenUpdate`**

Удалить из `popup.js` блок `function openUpdateDb()` … `function forgetDirHandle()` (строки 712–743). Заменить три вызова:

```js
  loadDirHandle()
```
→
```js
  DzenUpdate.loadDirHandle()
```

```js
    forgetDirHandle().catch(function () {});
```
→
```js
    DzenUpdate.forgetDirHandle().catch(function () {});
```

```js
      await saveDirHandle(root);
```
→
```js
      await DzenUpdate.saveDirHandle(root);
```

- [ ] **Step 5: Собрать и прогнать**

```bash
node tools/build-extension.cjs
bash test/run-suite.sh --only reliability,popup
```
Expected: оба набора зелёные, провалов 0.

- [ ] **Step 6: Коммит**

```bash
git add src/extension-src/update.js src/extension-src/popup.js test/test-reliability.cjs
git -c user.name="zanzibara82" -c user.email="294739332+zanzibara82@users.noreply.github.com" commit -m "update.js: помощники рукояти папки переехали из попапа"
```

---

## Task 3: окно подбора `images.html` и `images-page.js`

**Files:**
- Create: `src/extension-src/images.html`
- Create: `src/extension-src/images-page.js`
- Modify: `src/extension-src/manifest.json` (`options_ui.page`)
- Modify: `tools/build-extension.cjs` (`FILES`)
- Test: `test/test-popup.cjs` (новый блок после блока автообновления)
- Test: `test/test-reliability.cjs` (раздел 29: передать `images.html`)
- Test: `test/test-docs.cjs` (состав: передать `images.html`)

**Interfaces:**
- Consumes: `DzenUpdate.loadDirHandle/saveDirHandle/writeRel/installDirProblem`, `DzenImages.*`.
- Produces: страницу `chrome-extension://<id>/images.html?title=<...>` с маркерами готовности `data-dzr-images="ready" | "blocked" | "running" | "done"`.

- [ ] **Step 1: Подготовить падающие тесты**

1а. В `test/test-reliability.cjs`, раздел 29, заменить чтение и вызов:

```js
      const popupHtml = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "popup.html"), "utf8");
      const imagesHtml = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "images.html"), "utf8");
      const set = upd.updateFileSet(manifest, { "popup.html": popupHtml, "images.html": imagesHtml });
```

В `mustHave` добавить строки:

```js
        "images.html", "images.js", "images-page.js",
```

Комментарий про `options_ui` заменить на:

```js
      // options_ui указывает на images.html, action.default_popup — на popup.html.
      // images-page.js виден только из images.html, поэтому текст страницы обязателен.
```

1б. В `test/test-docs.cjs` после `const popupHtml = read("popup.html");` добавить:

```js
const imagesHtml = read("images.html");
```

В блоке «состав обновления против списка сборки» заменить:

```js
  const need = upd.updateFileSet(manifest, { "popup.html": popupHtml });
```
на
```js
  const need = upd.updateFileSet(manifest, { "popup.html": popupHtml, "images.html": imagesHtml });
```

Добавить после проверки `каждый нужный файл лежит в собранной папке`:

```js
  check("манифест: окно подбора — страница параметров",
    manifest.options_ui && manifest.options_ui.page === "images.html",
    JSON.stringify(manifest.options_ui));
  check("окно подбора подключает свой скрипт",
    /<script\b[^>]*\ssrc\s*=\s*["']images-page\.js["']/.test(imagesHtml),
    "нет images-page.js в images.html");
```

1в. В `test/test-popup.cjs` вставить новый блок сразу после закрывающей `}` блока «выбор папки и рукоять (автообновление)» и перед `const savedLinks = await evalJs(...)`:

```js
    // ---- подбор изображений (окно images.html) ----------------------------
    // Панель — контент-скрипт: у неё нет ни рукояти папки, ни права просить
    // доступ к чужим сайтам. Всё делает окно расширения; проверки ниже гоняют
    // его с подставными fetch, рукоятью, IndexedDB и правами.
    {
      try {
        const realName = JSON.parse(fs.readFileSync(path.join(SRC_EXT, "manifest.json"), "utf8")).name;
        const fixSrc = ["fake-dir-handle.cjs", "memory-idb.cjs"]
          .map((f) => fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8")).join("\n;\n");
        const b64 = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p))).toString("base64");
        const IMG = {
          jpg: b64([[0xff, 0xd8, 0xff, 0xe0], "one"]),
          png: b64([[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "two"]),
          webp: b64(["RIFF", [0, 0, 0, 0], "WEBP", "four"]),
          gif: b64(["GIF89a", "five"]),
          jpg2: b64([[0xff, 0xd8, 0xff, 0xe0], "six"])
        };
        const BING = '{"murl&quot;:&quot;https://img.test/a.jpg&quot;} {"murl":"https://img.test/heavy.jpg"} {"murl":"https://img.test/notimage.jpg"}';
        const YANDEX = '{"origUrl":"https://img.test/b.png"} {"origUrl":"https://img.test/c.webp"} {"origUrl":"https://img.test/d.gif"} {"origUrl":"https://img.test/e.jpg"} {"origUrl":"https://img.test/a.jpg"}';
        const images = {
          "https://img.test/a.jpg": { kind: "bytes", b64: IMG.jpg },
          "https://img.test/heavy.jpg": { kind: "heavy" },
          "https://img.test/notimage.jpg": { kind: "html" },
          "https://img.test/b.png": { kind: "bytes", b64: IMG.png },
          "https://img.test/c.webp": { kind: "bytes", b64: IMG.webp },
          "https://img.test/d.gif": { kind: "bytes", b64: IMG.gif },
          "https://img.test/e.jpg": { kind: "bytes", b64: IMG.jpg2 }
        };
        const goodManifest = JSON.stringify({ manifest_version: 3, name: realName, version: "2.4.0" });
        const seedFiles = { "manifest.json": goodManifest };

        const imagesCase = async (o) => {
          const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
          const attached = await c.send("Target.attachToTarget", { targetId, flatten: true });
          const sid = attached.sessionId;
          await c.send("Runtime.enable", {}, sid);
          await c.send("Page.enable", {}, sid);
          const ev = async (expr) => {
            const res = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
            if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
            return res.result.value;
          };
          const setup = `(function () {
            if (!/^chrome-extension:/.test(location.protocol)) return;
            var root = makeFakeRoot(${JSON.stringify(o.files || seedFiles)}, {
              permission: ${JSON.stringify(o.permission || "granted")},
              request: ${o.ask === false ? "false" : "true"}
            });
            var mem = globalThis.memoryIdb;
            var db = mem.open('dzr-update').__db;
            db.createObjectStore('handles');
            ${o.seed ? "mem.seed(db, root);" : ""}
            Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open: function (n) { return mem.open(n); } } });
            window.__img = { root: root, db: db, fetches: [], tabs: [], permRequests: [], picker: null };
            chrome.storage.sync.get = function (defaults, cb) { cb(Object.assign({}, defaults, { imageCount: ${o.count == null ? 8 : Number(o.count)} })); };
            chrome.permissions.contains = function (d, cb) { cb(${o.net !== false}); };
            chrome.permissions.request = function (d, cb) { window.__img.permRequests.push(((d && d.origins) || []).join()); cb(${o.grantNet !== false}); };
            chrome.tabs.create = function (d) { window.__img.tabs.push(d && d.url); };
            window.showDirectoryPicker = function (opts) {
              window.__img.picker = (opts && opts.mode) || "?";
              return ${o.picker === false ? "Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' }))" : "Promise.resolve(root)"};
            };
            var imgs = ${JSON.stringify(o.images || images)};
            function resp(body, status) { return new Response(body, { status: status || 200 }); }
            window.fetch = function (url, opts) {
              var u = String(url);
              window.__img.fetches.push(u);
              if (u.indexOf('bing.com') >= 0) return Promise.resolve(resp(${JSON.stringify(o.bing == null ? BING : o.bing)}));
              if (u.indexOf('yandex.ru') >= 0) return Promise.resolve(resp(${JSON.stringify(o.yandex == null ? YANDEX : o.yandex)}));
              var desc = imgs[u];
              if (!desc) return Promise.resolve(resp('', 404));
              var make = function () {
                if (desc.kind === 'heavy') {
                  var big = new Uint8Array(3 * 1024 * 1024 + 1);
                  big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
                  var hs = new ReadableStream({ start: function (cc) { cc.enqueue(big); cc.close(); } });
                  return new Response(hs, { status: 200 });
                }
                if (desc.kind === 'html') return new Response('<!doctype html><h1>не картинка</h1>', { status: 200 });
                if (desc.status) return new Response('', { status: desc.status });
                var raw = atob(desc.b64);
                var bytes = new Uint8Array(raw.length);
                for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                var rs = new ReadableStream({ start: function (cc) { cc.enqueue(bytes); cc.close(); } });
                return new Response(rs, { status: 200 });
              };
              var wait = ${Number(o.delay) || 0};
              if (!wait) return Promise.resolve(make());
              return new Promise(function (resolve, reject) {
                var timer = setTimeout(function () { resolve(make()); }, wait);
                if (opts && opts.signal) opts.signal.addEventListener('abort', function () {
                  clearTimeout(timer);
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                });
              });
            };
          })();`;
          const added = await c.send("Page.addScriptToEvaluateOnNewDocument", { source: fixSrc + "\n;\n" + setup }, sid);
          try {
            const title = o.title == null ? "" : o.title;
            const url = `chrome-extension://${extId}/images.html` + (title ? "?title=" + encodeURIComponent(title) : "");
            await c.send("Page.navigate", { url }, sid);
            for (let i = 0; i < 80; i++) {
              const state = await ev(`document.documentElement && document.documentElement.getAttribute('data-dzr-images')`);
              if (state === "done" || state === "blocked") break;
              if (state === "ready" && !o.title) break;
              if (o.stop && state === "running" && (await ev(`!document.getElementById('stop').hidden`))) break;
              await sleep(150);
            }
            if (o.stop) {
              await ev(`document.getElementById('stop').click()`);
              for (let i = 0; i < 40; i++) {
                if (await ev(`document.documentElement.getAttribute('data-dzr-images') === 'done'`)) break;
                await sleep(150);
              }
            }
            if (o.after) await ev(o.after);
            return await ev(`(function () {
              var p = window.__img;
              var files = Object.keys(p.root.__files);
              var sizes = {};
              files.forEach(function (k) { sizes[k] = p.root.__files[k].length; });
              return {
                status: document.getElementById('status').textContent,
                cls: document.getElementById('status').className,
                count: document.getElementById('count').textContent,
                chooseHidden: document.getElementById('choose-dir').hidden,
                writeHidden: document.getElementById('allow-write').hidden,
                netHidden: document.getElementById('allow-net').hidden,
                startHidden: document.getElementById('start').hidden,
                stopHidden: document.getElementById('stop').hidden,
                files: files, sizes: sizes,
                fetches: p.fetches, tabs: p.tabs, permRequests: p.permRequests,
                saved: !!p.db.__store['install-dir'],
                sameHandle: p.db.__store['install-dir'] === p.root,
                picker: p.picker
              };
            })()`);
          } finally {
            await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: added.identifier }, sid);
            await c.send("Target.closeTarget", { targetId });
          }
        };

        const happy = await imagesCase({ title: "Новая модель Subaru", count: 5, seed: true });
        console.log("подбор: счастливый путь: %j", { status: happy.status, files: happy.files });
        const wantFiles = [
          "news/Новая модель Subaru/01.jpg",
          "news/Новая модель Subaru/02.png",
          "news/Новая модель Subaru/03.webp",
          "news/Новая модель Subaru/04.gif",
          "news/Новая модель Subaru/05.jpg"
        ];
        check("окно скачало пять фото в news/<заголовок>",
          JSON.stringify(happy.files.slice().sort()) === JSON.stringify(wantFiles.slice().sort()),
          JSON.stringify(happy.files));
        check("статус называет папку и число записанных",
          /5 из 5/.test(happy.status) && /news\/Новая модель Subaru/.test(happy.status), happy.status);
        check("ссылка-дубль скачана один раз",
          happy.fetches.filter((u) => /\/a\.jpg$/.test(u)).length === 1,
          JSON.stringify(happy.fetches));

        const fewer = await imagesCase({
          title: "Короткая выдача", count: 5, seed: true,
          bing: '{"murl":"https://img.test/a.jpg"} {"murl":"https://img.test/b.png"}',
          yandex: ""
        });
        check("нехватка картинок: записаны найденные, статус «2 из 5»",
          fewer.files.length === 2 && /2 из 5/.test(fewer.status),
          JSON.stringify({ files: fewer.files, status: fewer.status }));

        const empty = await imagesCase({ title: "Пустая выдача", count: 5, seed: true, bing: "", yandex: "" });
        check("пустая выдача: папки нет и причина названа",
          empty.files.length === 0 && /ссылк/i.test(empty.status),
          JSON.stringify({ files: empty.files, status: empty.status }));

        const noNet = await imagesCase({
          title: "Без сети", seed: true, net: false, grantNet: false,
          after: `(async () => { document.getElementById('allow-net').click(); await new Promise((r) => setTimeout(r, 300)); })()`
        });
        check("без широкого права показана кнопка доступа", noNet.netHidden === false, JSON.stringify(noNet));
        check("отказ в доступе к сайтам — причина, запросов нет",
          /err/.test(noNet.cls) && /доступ|сайт/i.test(noNet.status) && noNet.fetches.length === 0,
          JSON.stringify({ status: noNet.status, fetches: noNet.fetches }));

        const noWrite = await imagesCase({
          title: "Без записи", seed: true, permission: "prompt", ask: false,
          after: `(async () => { document.getElementById('allow-write').click(); await new Promise((r) => setTimeout(r, 300)); })()`
        });
        check("без права записи показана кнопка разрешения", noWrite.writeHidden === false, JSON.stringify(noWrite));
        check("отказ в записи назван причиной, файлов нет",
          /err/.test(noWrite.cls) && /запис/i.test(noWrite.status) && noWrite.files.length === 0,
          JSON.stringify({ status: noWrite.status, files: noWrite.files }));

        const noHandle = await imagesCase({ waitDone: false });
        check("без рукояти предложен выбор папки", noHandle.chooseHidden === false, JSON.stringify(noHandle));

        const chosen = await imagesCase({
          waitDone: false,
          after: `(async () => { document.getElementById('choose-dir').click(); await new Promise((r) => setTimeout(r, 400)); })()`
        });
        check("выбранная папка сохранена в IndexedDB",
          chosen.saved === true && chosen.sameHandle === true && chosen.picker === "readwrite",
          JSON.stringify({ saved: chosen.saved, same: chosen.sameHandle, picker: chosen.picker }));

        const evil = await imagesCase({ title: "../../evil", count: 5, seed: true });
        check("имя папки очищено: ни одного «..», всё внутри news/",
          evil.files.length > 0 && evil.files.every((p) => p.indexOf("news/evil/") === 0 && p.indexOf("..") < 0),
          JSON.stringify(evil.files));

        const clampLow = await imagesCase({ count: 4, seed: true, waitDone: false });
        const clampHigh = await imagesCase({ count: 99, seed: true, waitDone: false });
        check("настройка 4 читается как 5", /Сколько фото: 5/.test(clampLow.count), clampLow.count);
        check("настройка 99 ограничена 10", /Сколько фото: 10/.test(clampHigh.count), clampHigh.count);

        const settingsCase = await imagesCase({
          seed: true, waitDone: false,
          after: `document.getElementById('settings').click()`
        });
        check("кнопка «Настройки» открывает popup.html",
          settingsCase.tabs.length === 1 && /popup\.html$/.test(settingsCase.tabs[0]),
          JSON.stringify(settingsCase.tabs));

        const many = {};
        const bingMany = [];
        for (let i = 0; i < 20; i++) {
          many["https://img.test/s" + i + ".jpg"] = { kind: "bytes", b64: IMG.jpg };
          bingMany.push('{"murl":"https://img.test/s' + i + '.jpg"}');
        }
        const stopped = await imagesCase({
          title: "Долгая загрузка", count: 5, seed: true, stop: true, delay: 1000,
          bing: bingMany.join(" "), yandex: "", images: many
        });
        check("остановка не ждёт загрузок и называет записанное",
          /Остановлено/.test(stopped.status) && stopped.files.length === 0 && stopped.startHidden === false,
          JSON.stringify({ status: stopped.status, files: stopped.files }));
      } catch (e) {
        check("окно подбора не роняет набор", false, String((e && e.message) || e));
      }
    }
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
node tools/build-extension.cjs
bash test/run-suite.sh --only docs,reliability,popup
```
Expected:
- `docs`: FAIL `не нахожу images.html` (падение чтения) или провал состава;
- `reliability`: FAIL чтения `images.html` в разделе 29;
- `popup`: FAIL `окно подбора не роняет набор` — страницы нет.

- [ ] **Step 3: Создать `src/extension-src/images.html`**

```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <title>Подбор изображений — Дзен Рерайтер</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; padding: 20px;
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #18181b; color: #e9d5ff;
    }
    h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
    .logo {
      display: inline-block; width: 26px; height: 26px; margin-right: 6px;
      border-radius: 8px; background: #7c3aed; color: #fff;
      text-align: center; line-height: 26px; font-weight: 700;
    }
    .hint { margin: 8px 0 0; color: #c4b5fd; font-size: 12.5px; }
    label { display: block; margin-top: 16px; font-size: 12.5px; color: #c4b5fd; }
    input[type="text"] {
      width: 100%; margin-top: 6px; padding: 9px 11px; box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px;
      background: rgba(255, 255, 255, 0.06); color: #f5f3ff; font-size: 14px;
    }
    input[type="text"]:disabled { opacity: 0.7; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    button {
      padding: 8px 14px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.06); color: #e9d5ff; font-size: 13px; cursor: pointer;
    }
    button:hover { background: rgba(255, 255, 255, 0.14); }
    button:disabled { opacity: 0.55; cursor: default; }
    button.primary { background: #7c3aed; border-color: #7c3aed; color: #fff; }
    button.primary:hover { background: #6d28d9; }
    .status {
      margin-top: 16px; padding: 10px 12px; border-radius: 8px;
      background: rgba(255, 255, 255, 0.06); min-height: 20px; white-space: pre-wrap;
    }
    .status.err { background: rgba(248, 113, 113, 0.16); color: #fecaca; }
    .status.ok { background: rgba(74, 222, 128, 0.14); color: #bbf7d0; }
    .status.warn { background: rgba(251, 191, 36, 0.14); color: #fde68a; }
  </style>
</head>
<body>
  <h1><span class="logo">Д</span> Изображения для новости</h1>
  <p class="hint">Фото скачиваются в папку установки: <b>news/&lt;заголовок&gt;</b>. Перед публикацией проверьте права на изображения.</p>

  <label for="title">Заголовок новости</label>
  <input id="title" type="text" maxlength="300" placeholder="По нему ищутся картинки" />

  <p id="count" class="hint">Сколько фото: 8 (меняется в настройках)</p>

  <div class="row">
    <button id="start" type="button" class="primary">Подобрать</button>
    <button id="stop" type="button" hidden>Остановить</button>
    <button id="settings" type="button">Настройки</button>
  </div>

  <div class="row">
    <button id="choose-dir" type="button" hidden>Выбрать папку установки</button>
    <button id="allow-write" type="button" hidden>Разрешить запись</button>
    <button id="allow-net" type="button" hidden>Разрешить доступ к сайтам с картинками</button>
  </div>

  <div id="status" class="status" role="status">Проверяю папку и права…</div>

  <script src="update.js"></script>
  <script src="images.js"></script>
  <script src="images-page.js"></script>
</body>
</html>
```

- [ ] **Step 4: Создать `src/extension-src/images-page.js`**

```js
/* Дзен Рерайтер — окно подбора изображений для новости.
   Окно живёт на происхождении расширения: только здесь есть рукоять папки
   установки и можно попросить доступ к сайтам с картинками. Панель на странице
   Дзена этого не может и лишь присылает сюда заголовок. */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var WIDE_ORIGINS = ["https://*/*"];
  var SEARCH_TIMEOUT_MS = 15000;
  var SEARCH_MAX_BYTES = 2 * 1024 * 1024;
  var IMAGE_TIMEOUT_MS = 12000;
  var WORKERS = 4;

  var root = null;
  var running = false;
  var abort = null;
  var written = 0;
  var wantCount = DzenImages.DEFAULT_COUNT;
  var folderName = "";
  var canWrite = false;
  var canNet = false;
  var autoStarted = false;

  function setStatus(text, kind) {
    var el = $("status");
    el.className = "status" + (kind ? " " + kind : "");
    el.textContent = text;
  }

  function setBusy(on) {
    running = on;
    $("start").hidden = on;
    $("stop").hidden = !on;
    $("title").disabled = on;
  }

  // Маркер состояния для браузерного набора: ready — можно подбирать,
  // blocked — ждём прав или папки, running — идёт подбор, done — закончили.
  function mark(state) {
    document.documentElement.setAttribute("data-dzr-images", state);
  }

  function readTitle() {
    var t = $("title").value;
    return String(t == null ? "" : t).replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function queryTitle() {
    try {
      return String(new URLSearchParams(location.search).get("title") || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
    } catch (e) {
      return "";
    }
  }

  function loadCount() {
    chrome.storage.sync.get({ imageCount: DzenImages.DEFAULT_COUNT }, function (res) {
      wantCount = DzenImages.clampCount(res && res.imageCount);
      $("count").textContent = "Сколько фото: " + wantCount + " (меняется в настройках)";
    });
  }

  function updateReady() {
    $("choose-dir").hidden = !!root;
    $("allow-write").hidden = !root || canWrite;
    $("allow-net").hidden = canNet;
    var ready = !!root && canWrite && canNet;
    if (!running) mark(ready ? "ready" : "blocked");
    return ready;
  }

  function queryWrite() {
    if (!root) return Promise.resolve(false);
    return root.queryPermission({ mode: "readwrite" }).then(function (state) {
      canWrite = state === "granted";
      return canWrite;
    }).catch(function () {
      canWrite = false;
      return false;
    });
  }

  function netGranted() {
    return new Promise(function (resolve) {
      chrome.permissions.contains({ origins: WIDE_ORIGINS }, function (yes) {
        canNet = !!yes && !chrome.runtime.lastError;
        resolve(canNet);
      });
    });
  }

  // Таймаут поверх внешнего сигнала отмены: отмена пользователя и таймаут
  // приходят по одному и тому же пути, и различать их не нужно.
  function withTimeout(signal, ms) {
    var ctl = new AbortController();
    var timer = setTimeout(function () {
      ctl.abort();
    }, ms);
    var onAbort = function () {
      ctl.abort();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: ctl.signal,
      done: function () {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    };
  }

  async function readCapped(res, cap) {
    var len = res.headers.get("content-length");
    if (len && Number(len) > cap) throw new Error("тяжелее потолка");
    if (!res.body || typeof res.body.getReader !== "function") {
      var buf = await res.arrayBuffer();
      if (buf.byteLength > cap) throw new Error("тяжелее потолка");
      return new Uint8Array(buf);
    }
    var reader = res.body.getReader();
    var chunks = [];
    var total = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      total += step.value.length;
      if (total > cap) {
        try { await reader.cancel(); } catch (e) {}
        throw new Error("тяжелее потолка");
      }
      chunks.push(step.value);
    }
    var out = new Uint8Array(total);
    var at = 0;
    chunks.forEach(function (c) {
      out.set(c, at);
      at += c.length;
    });
    return out;
  }

  async function fetchCapped(url, cap, ms, signal) {
    var t = withTimeout(signal, ms);
    try {
      var res = await fetch(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: t.signal
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await readCapped(res, cap);
    } finally {
      t.done();
    }
  }

  async function searchOne(url, parse, signal) {
    try {
      var bytes = await fetchCapped(url, SEARCH_MAX_BYTES, SEARCH_TIMEOUT_MS, signal);
      return parse(new TextDecoder("utf-8").decode(bytes));
    } catch (e) {
      if (signal && signal.aborted) throw e;
      return [];
    }
  }

  function searchBoth(title, signal) {
    var q = encodeURIComponent(title);
    var bing = "https://www.bing.com/images/async?q=" + q + "&first=0&count=35&mmasync=1";
    var yandex = "https://yandex.ru/images/search?text=" + q;
    return Promise.all([
      searchOne(bing, DzenImages.parseBing, signal),
      searchOne(yandex, DzenImages.parseYandex, signal)
    ]).then(function (lists) {
      return DzenImages.mergeCandidates(lists, DzenImages.MAX_CANDIDATES);
    });
  }

  function digestHex(bytes) {
    return crypto.subtle.digest("SHA-256", bytes).then(function (hash) {
      return Array.prototype.map.call(new Uint8Array(hash), function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join("");
    });
  }

  async function downloadOne(url, signal) {
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    // Право выдано только на https: http-картинка не скачается, и тратить на неё
    // запрос, который упрётся в отказ, незачем.
    if (u.protocol !== "https:") return null;
    var bytes;
    try {
      bytes = await fetchCapped(url, DzenImages.MAX_IMAGE_BYTES, IMAGE_TIMEOUT_MS, signal);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      return null;
    }
    var ext = DzenImages.imageType(bytes);
    if (!ext) return null;
    var hash;
    try {
      hash = await digestHex(bytes);
    } catch (e) {
      return null;
    }
    return { bytes: bytes, ext: ext, hash: hash };
  }

  async function downloadPool(candidates, want, signal, onOne) {
    var queue = candidates.slice();
    var results = [];
    var seen = {};
    var stopped = false;

    async function worker() {
      while (!stopped && results.length < want && queue.length) {
        var url = queue.shift();
        var got;
        try {
          got = await downloadOne(url, signal);
        } catch (e) {
          if (signal && signal.aborted) throw e;
          continue;
        }
        if (!got || seen[got.hash]) continue;
        if (results.length >= want) break;
        seen[got.hash] = true;
        results.push(got);
        onOne(results.length);
        if (results.length >= want) stopped = true;
      }
    }

    var workers = [];
    for (var i = 0; i < WORKERS && i < candidates.length; i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  async function start() {
    if (running) return;
    var title = readTitle();
    if (!title) {
      setStatus("Впишите заголовок новости — по нему ищутся картинки.");
      $("title").focus();
      return;
    }
    if (!root) {
      updateReady();
      setStatus("Выберите папку установки расширения.", "err");
      return;
    }
    if (!canWrite) {
      updateReady();
      setStatus("Браузер не дал право записи в папку — нажмите «Разрешить запись».", "err");
      return;
    }
    if (!canNet) {
      updateReady();
      setStatus("Нет доступа к сайтам с картинками — нажмите «Разрешить доступ к сайтам с картинками».", "err");
      return;
    }

    written = 0;
    folderName = "";
    abort = new AbortController();
    var signal = abort.signal;
    setBusy(true);
    mark("running");
    setStatus("Ищу картинки…");
    try {
      var candidates = await searchBoth(title, signal);
      if (!candidates.length) {
        setStatus("Не удалось получить ссылки на картинки. Проверьте заголовок и повторите.", "err");
        return;
      }
      setStatus("Скачиваю фото (0 из " + wantCount + ")…");
      var found = await downloadPool(candidates, wantCount, signal, function (n) {
        setStatus("Скачиваю фото (" + n + " из " + wantCount + ")…");
      });
      if (!found.length) {
        setStatus("Найденные картинки не скачались: не картинки или тяжелее 3 МБ.", "err");
        return;
      }
      var news = await root.getDirectoryHandle("news", { create: true });
      var used = new Set();
      try {
        for await (var entry of news.entries()) used.add(entry[0]);
      } catch (e) {}
      folderName = DzenImages.nextFreeName(DzenImages.sanitizeFolderName(title, "novost"), used);
      for (var i = 0; i < found.length; i++) {
        var rel = "news/" + folderName + "/" + DzenImages.fileName(i, found[i].ext);
        await DzenUpdate.writeRel(root, rel, found[i].bytes);
        written++;
      }
      setStatus("Записано " + written + " из " + wantCount + ": news/" + folderName + "/",
        found.length < wantCount ? "warn" : "ok");
    } catch (e) {
      if (signal.aborted) {
        setStatus("Остановлено. Записано " + written +
          (folderName ? " в news/" + folderName + "/" : "."));
      } else {
        setStatus("Ошибка подбора: " + ((e && e.message) || String(e)) +
          (folderName ? " (папка news/" + folderName + "/, записано " + written + ")" : ""), "err");
      }
    } finally {
      abort = null;
      setBusy(false);
      $("start").textContent = "Подобрать заново";
      mark("done");
    }
  }

  $("start").addEventListener("click", start);

  $("stop").addEventListener("click", function () {
    if (!abort) return;
    abort.abort();
    setStatus("Останавливаю…");
  });

  $("title").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    start();
  });

  $("settings").addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  });

  $("choose-dir").addEventListener("click", async function () {
    if (typeof window.showDirectoryPicker !== "function") {
      setStatus("Этот браузер не умеет выбирать папку. Нужен Chrome или Яндекс Браузер.", "err");
      return;
    }
    var picked;
    try {
      // Диалог поднимается до первого ожидания: запрос жеста иначе отклонится.
      picked = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (e) {
      if (e && e.name === "AbortError") {
        setStatus("Выбор папки отменён.");
        return;
      }
      setStatus("Не удалось открыть папку: " + ((e && e.message) || e), "err");
      return;
    }
    var problem = await DzenUpdate.installDirProblem(picked, chrome.runtime.getManifest().name);
    if (problem) {
      setStatus("Это " + problem + ". Выберите папку установки расширения «Дзен Рерайтер».", "err");
      return;
    }
    root = picked;
    try {
      await DzenUpdate.saveDirHandle(root);
    } catch (e) {}
    await queryWrite();
    updateReady();
    setStatus(canWrite ? "Папка выбрана. Можно подбирать." : "Папка выбрана, но запись запрещена. Нажмите «Разрешить запись».", canWrite ? "" : "err");
  });

  $("allow-write").addEventListener("click", async function () {
    if (!root) return;
    var state;
    try {
      state = await root.requestPermission({ mode: "readwrite" });
    } catch (e) {
      state = "denied";
    }
    canWrite = state === "granted";
    updateReady();
    setStatus(canWrite ? "Запись разрешена. Можно подбирать." : "Браузер не дал право записи — подобрать не получится.", canWrite ? "" : "err");
  });

  $("allow-net").addEventListener("click", function () {
    chrome.permissions.request({ origins: WIDE_ORIGINS }, function (yes) {
      canNet = !!yes && !chrome.runtime.lastError;
      updateReady();
      setStatus(canNet ? "Доступ к сайтам получен. Можно подбирать." : "Без доступа к сайтам картинки не скачать.", canNet ? "" : "err");
    });
  });

  loadCount();
  var initial = queryTitle();
  if (initial) $("title").value = initial;
  DzenUpdate.loadDirHandle()
    .then(function (handle) {
      root = handle || null;
    })
    .catch(function () {
      root = null;
    })
    .then(queryWrite)
    .then(netGranted)
    .then(function () {
      var ready = updateReady();
      if (ready && initial && !autoStarted) {
        autoStarted = true;
        start();
      }
    });
})();
```

- [ ] **Step 5: Перенести `options_ui` на страницу подбора**

В `src/extension-src/manifest.json`:

```json
  "options_ui": {
    "page": "images.html",
    "open_in_tab": true
  },
```

`action.default_popup` оставить `popup.html`.

- [ ] **Step 6: Добавить файлы в сборку**

В `tools/build-extension.cjs`, массив `FILES`, после `"presets.js"`:

```js
  "images.js",
  "images.html",
  "images-page.js",
```

- [ ] **Step 7: Собрать и прогнать**

```bash
node tools/build-extension.cjs
bash test/run-suite.sh --only docs,reliability,popup
```
Expected: три набора зелёные. Если `popup` падает на `окно скачало пять фото` — посмотреть `files` в выводе: чаще всего это неверный порядок файлов (ожидается `01.jpg` от `a.jpg`).

- [ ] **Step 8: Коммит**

```bash
git add src/extension-src/images.html src/extension-src/images-page.js src/extension-src/manifest.json tools/build-extension.cjs test/test-popup.cjs test/test-reliability.cjs test/test-docs.cjs
git -c user.name="zanzibara82" -c user.email="294739332+zanzibara82@users.noreply.github.com" commit -m "Окно подбора изображений и его браузерный набор"
```

---

## Task 4: настройка «Сколько фото скачивать»

**Files:**
- Modify: `src/extension-src/background.js` (`DEFAULTS`)
- Modify: `src/extension-src/popup.html` (поле и подключение `images.js`)
- Modify: `src/extension-src/popup.js` (`FIELDS`, чтение, сохранение)
- Modify: `src/extension-src/README.md` (строка таблицы настроек)
- Test: `test/test-docs.cjs` (`SETTING_DOC` и сторож поля)

**Interfaces:**
- Consumes: `DzenImages.clampCount`.
- Produces: ключ `imageCount` в `chrome.storage.sync`, значение 5–10; его читает окно подбора.

- [ ] **Step 1: Написать падающий сторож**

В `test/test-docs.cjs`:

1. В `SETTING_DOC` после `linkCount`:

```js
  imageCount: "Сколько фото скачивать",
```

2. В строке таблицы README (следующий шаг) появится метка; сторож `строка «…» дословно есть в попапе` требует её и в попапе.

3. После проверки `update.js подключён раньше popup.js` добавить:

```js
  check("попап: поле количества фото с диапазоном 5–10",
    /id="imageCount"[^>]*min="5"[^>]*max="10"/.test(popupHtml),
    "нет поля #imageCount с min=5 и max=10");
  check("попап: images.js подключён раньше popup.js",
    popupHtml.indexOf('src="images.js"') >= 0 &&
    popupHtml.indexOf('src="images.js"') < popupHtml.indexOf('src="popup.js"'),
    JSON.stringify({ images: popupHtml.indexOf('src="images.js"'), popup: popupHtml.indexOf('src="popup.js"') }));
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
node tools/build-extension.cjs
bash test/run-suite.sh --only docs
```
Expected: FAIL `настройка imageCount названа в README`, `попап: поле количества фото…`, `попап: images.js подключён раньше popup.js`.

- [ ] **Step 3: Добавить ключ в `DEFAULTS`**

В `background.js`, после `linkCount: 2, // сколько ссылок ставить в статью`:

```js
  imageCount: 8, // сколько фото скачивать в подборе изображений (5–10)
```

`LOCAL_KEYS` не трогать: счётчик маленький и живёт в `sync`.

- [ ] **Step 4: Добавить поле в попап**

В `popup.html`, после блока `linkCount` (строки 358–362):

```html
      <label for="imageCount" style="margin-top: 12px">Сколько фото скачивать</label>
      <input id="imageCount" type="number" min="5" max="10" step="1" placeholder="8" />
      <p class="hint" style="margin: 6px 0 0">
        Сколько фотографий скачивать в папку новости: от 5 до 10. По умолчанию 8.
      </p>
```

В блоке скриптов, после `rewriter.js`:

```html
    <script src="images.js"></script>
```

Порядок: `presets.js`, `rewriter.js`, `images.js`, `update.js`, `popup.js`.

- [ ] **Step 5: Читать и сохранять `imageCount` в `popup.js`**

В `FIELDS` после `"linkCount"`:

```js
    "imageCount"
```

После цикла заполнения полей (после `FIELDS.forEach(...)`, перед `$("aiEnabled").checked`):

```js
    // Число фото храним числом и ограничиваем здесь же: пустое поле — это
    // «по умолчанию», а не NaN, и окно подбора увидит ровно то, что на экране.
    if ($("imageCount")) $("imageCount").value = DzenImages.clampCount(settings.imageCount);
```

В сохранении, после блока `linkCount` и до `send`:

```js
      next.imageCount = DzenImages.clampCount($("imageCount").value);
      $("imageCount").value = next.imageCount;
```

- [ ] **Step 6: Строка в README**

В таблицу настроек, после строки «Сколько ссылок на статью»:

```markdown
| Сколько фото скачивать | От 5 до 10, по умолчанию 8. Столько картинок окно подбора положит в папку новости |
```

- [ ] **Step 7: Собрать и прогнать**

```bash
node tools/build-extension.cjs
bash test/run-suite.sh --only docs,storage,popup
```
Expected: три набора зелёные. `storage` проверяет, что новое поле не потерялось при сохранении.

- [ ] **Step 8: Коммит**

```bash
git add src/extension-src/background.js src/extension-src/popup.html src/extension-src/popup.js src/extension-src/README.md test/test-docs.cjs
git -c user.name="zanzibara82" -c user.email="294739332+zanzibara82@users.noreply.github.com" commit -m "Настройка «Сколько фото скачивать» и её сторож"
```

---

## Task 5: кнопка панели и открытие окна из фона

**Files:**
- Modify: `src/extension-src/content.js` (иконка, переменная, кнопка, слушатель)
- Modify: `src/extension-src/content.css`
- Modify: `src/extension-src/background.js` (`openImagePicker`, ключ окна)
- Modify: `src/extension-src/manifest.json` (`content_scripts.js`)
- Test: `test/test-ui.cjs`
- Test: `test/test-reliability.cjs` (подставной `chrome.windows`)
- Test: `test/test-docs.cjs` (сторож порядка скриптов)

**Interfaces:**
- Consumes: `DzenImages.guessTitle`, `findEditor()`, `send()`, `setStatus()` из `content.js`; `chrome.windows`, `chrome.storage.session`.
- Produces: сообщение `{ type: "openImagePicker", title }` и окно `images.html?title=…`.

- [ ] **Step 1: Написать падающие тесты**

1а. `test/test-ui.cjs`: перед `await c.send("Target.closeTarget", { targetId: probe.targetId });` (после проверок режима) вставить:

```js
    // Кнопка подбора изображений: панель не имеет права открывать окно сама —
    // она отправляет заголовок фону, а фон поднимает страницу расширения.
    const imgBtn = await evalJs(`(() => {
      const b = document.querySelector('#dzr-bar .dzr-images-btn');
      return b ? { text: b.textContent.trim(), title: b.title } : null;
    })()`);
    check("в панели есть кнопка подбора изображений",
      !!imgBtn && /Изображен/i.test(imgBtn.text), JSON.stringify(imgBtn));
    if (imgBtn) {
      await evalJs(`document.querySelector('#dzr-bar .dzr-images-btn').click()`);
      let imgTarget = null;
      for (let i = 0; i < 40; i++) {
        const { targetInfos } = await c.send("Target.getTargets");
        imgTarget = targetInfos.find((t) => /images\.html/.test(t.url));
        if (imgTarget) break;
        await sleep(150);
      }
      check("кнопка открывает окно подбора с заголовком статьи",
        !!imgTarget && /images\.html\?title=[^&]*Subaru/.test(imgTarget.url),
        imgTarget && imgTarget.url);
      if (imgTarget) await c.send("Target.closeTarget", { targetId: imgTarget.targetId });
    }
```

1б. `test/test-reliability.cjs`: в подставной `chrome` добавить рядом с `tabs`:

```js
  windows: {
    create: async () => ({ id: 1 }),
    update: async () => ({}),
    onRemoved: { addListener() {} }
  },
```

1в. `test/test-docs.cjs`: после сторожа `фон подключает update.js в воркере`:

```js
  const cs = (manifest.content_scripts || [])[0] || {};
  const csJs = cs.js || [];
  check("манифест: images.js подключён перед content.js",
    csJs.indexOf("images.js") >= 0 && csJs.indexOf("images.js") < csJs.indexOf("content.js"),
    JSON.stringify(csJs));
  check("окно подбора открывает настройки",
    /chrome\.tabs\.create/.test(read("images-page.js")) && /popup\.html/.test(read("images-page.js")),
    "нет chrome.tabs.create с popup.html");
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
node tools/build-extension.cjs
bash test/run-suite.sh --only ui,docs,reliability
```
Expected: FAIL `в панели есть кнопка подбора изображений`, `манифест: images.js подключён перед content.js`.

- [ ] **Step 3: Добавить иконку и кнопку в `content.js`**

Иконка, после строки `download:` в объекте `paths`:

```js
      image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-4.5-4.5L9 18"/>'
```

Объявление переменной (строка 39):

```js
  var bar, statusEl, goBtn, undoBtn, langSel, modeSel, presetSel, linkBtn, imagesBtn, srcUrlInput, srcBtn;
```

В `buildBar`, после создания `linkBtn` и до `collapseBtn`:

```js
    // Подбор картинок — третья задача панели: не переписать и не расставить
    // ссылки, а принести фото к новости. Сама панель файлов не качает: у неё нет
    // ни рукояти папки, ни права просить доступ к чужим сайтам.
    imagesBtn = document.createElement("button");
    imagesBtn.type = "button";
    imagesBtn.className = "dzr-images-btn";
    imagesBtn.title = "Подобрать изображения для новости";
    imagesBtn.innerHTML = icon("image") + "<span>Изображения</span>";
```

После `bar.appendChild(linkBtn);`:

```js
    bar.appendChild(imagesBtn);
```

Слушатель, после слушателя `linkBtn`:

```js
    imagesBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var title = "";
      try {
        title = globalThis.DzenImages ? DzenImages.guessTitle(document, findEditor()) : "";
      } catch (err) {
        title = "";
      }
      send({ type: "openImagePicker", title: title }).then(function (res) {
        if (!res || !res.ok) {
          setStatus("Не удалось открыть подбор изображений: " + ((res && res.error) || "фон не ответил"), "err");
        }
      });
    });
```

- [ ] **Step 4: Стили кнопки в `content.css`**

В списке скрытых в свёрнутой панели добавить строку:

```css
#dzr-bar.dzr-collapsed .dzr-images-btn,
```

Базовая группа (строка 107) — добавить второй селектор:

```css
.dzr-link-btn,
.dzr-images-btn {
```

Аналогично `:hover`, `:disabled` и `svg`. Вертикальная раскладка:

```css
#dzr-bar.dzr-vertical .dzr-link-btn,
#dzr-bar.dzr-vertical .dzr-images-btn {
  width: 42px;
  height: 42px;
  padding: 0;
  justify-content: center;
}
#dzr-bar.dzr-vertical .dzr-link-btn > span:last-child,
#dzr-bar.dzr-vertical .dzr-images-btn > span:last-child {
  display: none;
}
```

Правило `.dzr-link-btn.dzr-cancel` оставить только у перелинковки.

- [ ] **Step 5: Открытие окна в `background.js`**

Перед `async function buildUpdatePackage()` вставить:

```js
// ------------------------------------------------------- окно подбора фото ---
// Номер окна живёт в session-хранилище: перезапуск воркера его не теряет, а
// закрытие вкладки-окна — удаляет.
const IMAGE_WINDOW_KEY = "dzrImageWindowId";

function imagePickerUrl(title) {
  var base = chrome.runtime.getURL("images.html");
  var t = String(title == null ? "" : title).replace(/\s+/g, " ").trim().slice(0, 300);
  return t ? base + "?title=" + encodeURIComponent(t) : base;
}

async function readImageWindowId() {
  const session = chrome.storage && chrome.storage.session;
  if (!session) return null;
  try {
    const st = await session.get({ [IMAGE_WINDOW_KEY]: null });
    return st[IMAGE_WINDOW_KEY] || null;
  } catch (e) {
    return null;
  }
}

async function writeImageWindowId(id) {
  const session = chrome.storage && chrome.storage.session;
  if (!session) return;
  try {
    if (id == null) await session.remove(IMAGE_WINDOW_KEY);
    else await session.set({ [IMAGE_WINDOW_KEY]: id });
  } catch (e) {}
}

async function openImagePicker(title) {
  const url = imagePickerUrl(title);
  const existing = await readImageWindowId();
  if (existing != null) {
    try {
      await chrome.windows.update(existing, { focused: true });
      return { ok: true, windowId: existing, reused: true };
    } catch (e) {
      await writeImageWindowId(null);
    }
  }
  try {
    const win = await chrome.windows.create({ url, type: "popup", width: 560, height: 720 });
    if (win && win.id != null) {
      await writeImageWindowId(win.id);
      return { ok: true, windowId: win.id, reused: false };
    }
  } catch (e) {}
  const tab = await chrome.tabs.create({ url });
  return { ok: true, windowId: null, tabId: tab && tab.id != null ? tab.id : null };
}

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener(async (id) => {
    const current = await readImageWindowId();
    if (current != null && current === id) await writeImageWindowId(null);
  });
}
```

В обработчике сообщений, перед `sendResponse({ ok: false, error: "Неизвестный тип сообщения: " + msg.type });`:

```js
      if (msg.type === "openImagePicker") {
        sendResponse(await openImagePicker(msg.title));
        return;
      }
```

- [ ] **Step 6: Добавить `images.js` в контент-скрипты**

В `manifest.json`:

```json
      "js": ["presets.js", "rewriter.js", "images.js", "content.js"],
```

- [ ] **Step 7: Собрать и прогнать**

```bash
node tools/build-extension.cjs
bash test/run-suite.sh --only docs,reliability,ui,mocks
```
Expected: четыре набора зелёные. Если окно не появляется — проверить, что `Target.getTargets` видит попап-окно, и что `openImagePicker` не падает на `chrome.storage.session`.

- [ ] **Step 8: Коммит**

```bash
git add src/extension-src/content.js src/extension-src/content.css src/extension-src/background.js src/extension-src/manifest.json test/test-ui.cjs test/test-reliability.cjs test/test-docs.cjs
git -c user.name="zanzibara82" -c user.email="294739332+zanzibara82@users.noreply.github.com" commit -m "Панель: кнопка «Изображения» и открытие окна подбора"
```

---

## Task 6: сборка сохраняет `news`, версия 2.4.0 и README

**Files:**
- Modify: `tools/build-extension.cjs`
- Modify: `src/extension-src/manifest.json`, `package.json`, `src/extension-src/popup.html`, `src/extension-src/README.md`
- Test: `test/test-reliability.cjs` (раздел 35)
- Test: `test/test-docs.cjs` (сторожа README и версии)

**Interfaces:**
- Consumes: собранная папка `--out` с подпапкой `news`.
- Produces: пересборка и автообновление не трогают `<папка установки>/news`.

- [ ] **Step 1: Написать падающий тест (раздел 35)**

Вставить перед `console.log("\n=== ИТОГ ===");` в `test/test-reliability.cjs`:

```js
  console.log("\n=== 35. сборка сохраняет папку news ===");
  {
    // Сборщик сносит выходную папку целиком. Без отдельного переноса он унёс бы
    // подобранные фотографии — и человек узнал бы об этом только по пустой news.
    const os = require("os");
    const { execFileSync } = require("child_process");
    let out = "";
    try {
      out = fs.mkdtempSync(path.join(os.tmpdir(), "dzen-rewriter-news-"));
      fs.mkdirSync(path.join(out, "news", "Тема"), { recursive: true });
      fs.writeFileSync(path.join(out, "news", "Тема", "01.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      fs.writeFileSync(path.join(out, "старый.txt"), "мусор");
      execFileSync(process.execPath, [path.join(PATHS.REPO, "tools", "build-extension.cjs"), "--out", out, "--no-zip"], { stdio: "pipe" });
      const kept = fs.readFileSync(path.join(out, "news", "Тема", "01.jpg"));
      check("news/<тема>/01.jpg пережил пересборку",
        kept.length === 4 && kept[0] === 0xff && kept[3] === 0xe0, JSON.stringify(Array.from(kept)));
      check("файлы расширения при этом обновились", fs.existsSync(path.join(out, "manifest.json")));
      check("чужой файл из папки установки убран", !fs.existsSync(path.join(out, "старый.txt")));
    } catch (e) {
      check("пересборка с news не роняет набор", false, String((e && e.message) || e));
    } finally {
      if (out) fs.rmSync(out, { recursive: true, force: true });
    }
  }
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node test/test-reliability.cjs`
Expected: FAIL `пересборка с news не роняет набор` — `ENOENT ... news/Тема/01.jpg` (сборщик снёс папку).

- [ ] **Step 3: Сохранять `news` в сборщике**

В `tools/build-extension.cjs` заменить блок от комментария `// 2. папка.` до конца копирования файлов на:

```js
  // 2. папка. Страховка: сносим только то, что похоже на нашу выходную папку —
  // иначе опечатка в --out могла бы удалить что-то чужое.
  if (fs.existsSync(args.out) && !/^dzen-rewriter/.test(path.basename(args.out))) {
    console.error(
      "Отказываюсь перезаписывать «" + args.out + "»: имя папки не похоже на сборочную.\n" +
        "Ожидается папка с именем, начинающимся на «dzen-rewriter»."
    );
    process.exit(1);
  }

  // Подобранные фотографии лежат внутри папки установки, а сборка сносит её
  // целиком. Переносим news в соседний временный путь до rmSync и возвращаем
  // после копирования; сосед — та же файловая система, иначе rename упрётся в EXDEV.
  const NEWS = path.join(args.out, "news");
  let newsBackup = null;
  if (fs.existsSync(NEWS)) {
    newsBackup = fs.mkdtempSync(path.join(path.dirname(args.out), ".dzr-news-"));
    fs.renameSync(NEWS, path.join(newsBackup, "news"));
  }

  try {
    fs.rmSync(args.out, { recursive: true, force: true });
    for (const rel of payload) {
      const dst = path.join(args.out, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(SRC, rel), dst);
    }
  } catch (e) {
    if (newsBackup) {
      try {
        fs.mkdirSync(args.out, { recursive: true });
        fs.renameSync(path.join(newsBackup, "news"), NEWS);
        newsBackup = null;
      } catch (e2) {
        console.error("НЕ УДАЛОСЬ ВЕРНУТЬ ПАПКУ news. Она лежит здесь: " + path.join(newsBackup, "news"));
      }
    }
    throw e;
  }

  if (newsBackup) {
    try {
      fs.renameSync(path.join(newsBackup, "news"), NEWS);
      fs.rmSync(newsBackup, { recursive: true, force: true });
    } catch (e) {
      console.error("НЕ УДАЛОСЬ ВЕРНУТЬ ПАПКУ news. Она лежит здесь: " + path.join(newsBackup, "news"));
      throw e;
    }
  }
```

Комментарий в шапке `FILES` дополнить строкой:

```js
// news в zip не попадает: zip собирается из этого списка, а папка news — данные
// пользователя, которые пересборка сохраняет, но не распространяет.
```

- [ ] **Step 4: Прогнать раздел 35**

Run: `node test/test-reliability.cjs`
Expected: PASS, раздел 35 без провалов.

- [ ] **Step 5: Поднять версию до 2.4.0 в четырёх местах**

- `src/extension-src/manifest.json`: `"version": "2.4.0"`.
- `package.json`: `"version": "2.4.0"`.
- `src/extension-src/popup.html`: `<span class="badge">v2.4.0</span>`.
- `src/extension-src/README.md:23`: `**2.4.0**`.

- [ ] **Step 6: Раздел README про подбор изображений**

После таблицы настроек (перед абзацем «Внизу вкладки настроек — кнопка …») вставить:

```markdown
### Подбор изображений для новости

На панели в редакторе Дзена есть кнопка **«Изображения»**. Она открывает окно подбора:
заголовок берётся из статьи, его можно поправить, и по нему ищутся фотографии в Bing
и Яндексе. В папку установки расширения скачивается от 5 до 10 картинок (число задаётся
настройкой «Сколько фото скачивать»), каждая не тяжелее 3 МБ:

```
<папка установки>/news/<заголовок новости>/01.jpg
```

Папка `news` создаётся при первом подборе. Повторная пересборка расширения и
автообновление её не удаляют. Для скачивания нужно разовое разрешение «Разрешить
доступ к сайтам с картинками»: без него расширение не может взять файл с чужого сайта.
Cookie и `Referer` при загрузке не отправляются. Права на изображения перед публикацией
проверяет пользователь: расширение не проверяет лицензии.
```

- [ ] **Step 7: Добавить сторожа README в `test/test-docs.cjs`**

После проверок версии:

```js
check("README называет подбор изображений", inReadme("Подбор изображений"));
check("README говорит про папку news", inReadme("news/"));
check("README называет потолок 3 МБ", /3\s*МБ/.test(readme));
check("README называет диапазон от 5 до 10", /от 5 до 10/.test(readme));
```

- [ ] **Step 8: Собрать и прогнать всё**

```bash
node tools/build-extension.cjs
bash test/run-suite.sh
```
Expected: 22 набора, провалов 0. Счётчик проверок будет больше, чем 1362 у 2.3.0 (добавились разделы 33–35 и блок окна подбора).

- [ ] **Step 9: Проверить чистый прогон и остатки**

```bash
git status --short
ls "$LOCALAPPDATA/Temp" | grep -i dzr || true
```
Expected: в `git status` только файлы этой задачи; если в `%TEMP%` остались `dzr-test-profile-*`, которых не даёт удалить система, записать их пути и размеры для доклада пользователю.

- [ ] **Step 10: Коммит и пуш**

```bash
git add tools/build-extension.cjs src/extension-src/manifest.json package.json src/extension-src/popup.html src/extension-src/README.md test/test-reliability.cjs test/test-docs.cjs
git -c user.name="zanzibara82" -c user.email="294739332+zanzibara82@users.noreply.github.com" commit -m "Версия 2.4.0: подбор изображений, сохранение news в сборке и README"
git push origin main
```

---

## Самопроверка плана

**Покрытие спеки**

| Раздел спеки | Задача |
| --- | --- |
| 3.1 чистые функции | Task 1 |
| 3.2 окно и порядок работы | Task 3 |
| 3.3 кнопка панели | Task 5 |
| 3.4 открытие окна из фона | Task 5 |
| 3.5 помощники рукояти из `popup.js` | Task 2 |
| 3.6 настройка `imageCount` | Task 4 |
| 3.7 сборка, манифест, перенос `options_ui` | Task 3 (файлы и `options_ui`), Task 5 (`images.js` в контент-скриптах), Task 6 (`news` и версия) |
| 4 источники и отбор | Task 3 (`searchBoth`, `downloadPool`) |
| 5 папки, имена и запись | Task 1 (`sanitizeFolderName`, `fileName`), Task 3 (`start`) |
| 6 права и безопасность | Task 3 (`allow-net`, `credentials:"omit"`, `textContent`), Task 5 (фон не кладёт ключи в сообщение) |
| 7 исходы | Task 3 (статусы и кнопки) |
| 8 тесты | Tasks 1, 2, 3, 5, 6 |
| 9 приёмка | Task 6 (версия и полная регрессия) |
| 10 автообновление и `news` | Task 3 (`options_ui`), Task 6 (сборщик) |

**Сверка имён**

- `DzenImages.MAX_IMAGE_BYTES`, `fileType` нет: используется `imageType` везде.
- `DzenUpdate.loadDirHandle/saveDirHandle/writeRel/installDirProblem` — имена совпадают с Task 2 и существующим `update.js`.
- Маркер готовности окна — `data-dzr-images` со значениями `ready`, `blocked`, `running`, `done`; тест Task 3 ждёт именно их.
- Поле настройки — `#imageCount`; метка «Сколько фото скачивать» совпадает в трёх местах: попап, `SETTING_DOC`, первая колонка README.

**Ловушки, уже заложенные в план**

- Окно подбора — единственное место с рукоятью и правами; панель только шлёт заголовок.
- `options_ui` переносится на `images.html`, иначе автообновление не принесёт окно.
- `news` не входит в `FILES`, поэтому не попадает в zip и в состав обновления.
- `chrome.windows` в юнит-наборе подставлен, иначе `onRemoved` уронил бы загрузку фона.
- `http:` картинки пропускаются при загрузке, хотя парсер их принимает.
- Сборщик переносит `news` до `rmSync`; при сбое возвращает в `catch`; при неудаче возврата печатает путь к резерву.
