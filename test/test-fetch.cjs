/**
 * Юнит-тест забора текста по адресу (background.js) без сети и без Chrome.
 *
 * Проверяем ровно то, что легко сломать незаметно: воркер открывает НЕ активную
 * вкладку, ждёт загрузки, вытаскивает статью и закрывает вкладку на любом
 * исходе. Раскладка панели и настоящая страница с разметкой — в браузерном
 * наборе test-source.cjs.
 *
 * background.js — не модуль, поэтому грузим его как тело функции с подставным
 * chrome: вкладками, скриптингом и правами управляем вручную.
 */
const fs = require("fs");
const path = require("path");
const PATHS = require("./paths.cjs");

const SRC = path.join(PATHS.REPO, "src", "extension-src", "background.js");

// ------------------------------------------------------------- подставной chrome
const localStore = {};
const calls = { created: [], removed: [], injected: [], permissions: [] };
let updatedListeners = [];
let injectResult = null; // что вернёт chrome.scripting.executeScript
let injectError = null; // или бросит
let permissionAllowed = true;
let nextTabId = 100;
// Как ведёт себя страница во вкладке: "complete" — догрузилась сразу,
// "never" — висит (проверка таймаута), "manual" — дожидается вызова из теста.
let pageLoad = "complete";

function fireUpdated(tabId, changeInfo) {
  for (const fn of updatedListeners) fn(tabId, changeInfo, { id: tabId });
}

/** Тест сам доводит вкладку до конца — для порядка «сначала слушатель, потом вкладка». */
function completeTab() {
  fireUpdated(calls.lastTabId, { status: "complete" });
}

const chrome = {
  storage: {
    sync: { get: async (d) => (d && !Array.isArray(d) ? { ...d } : {}), set: async () => {}, remove: async () => {} },
    local: {
      get: async (keys) => (keys == null ? { ...localStore } : Array.isArray(keys) ? { ...localStore } : { [keys]: localStore[keys] }),
      set: async (o) => Object.assign(localStore, o),
      remove: async (k) => { delete localStore[k]; }
    }
  },
  permissions: {
    contains: async ({ origins }) => {
      calls.permissions.push(origins.join(","));
      return permissionAllowed;
    },
    request: async () => true
  },
  runtime: {
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    getURL: (p) => "chrome-extension://test/" + p
  },
  contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  tabs: {
    create: async (props) => {
      const tab = { id: nextTabId++, windowId: 1 };
      calls.created.push(props);
      calls.lastTabId = tab.id;
      // Страница не успевает догрузиться до того, как воркер подписался на
      // события: событие уходит следующим маком, как в настоящем Chrome.
      if (pageLoad === "complete") setImmediate(() => completeTab());
      return tab;
    },
    remove: async (ids) => {
      calls.removed.push(ids);
    },
    update: async () => {},
    query: async () => [],
    sendMessage: async () => {},
    onUpdated: { addListener: (fn) => updatedListeners.push(fn), removeListener: () => {} }
  },
  scripting: {
    executeScript: async (details) => {
      calls.injected.push(details);
      if (injectError) throw new Error(injectError);
      return injectResult;
    }
  }
};

const SRC_TEXT = fs.readFileSync(SRC, "utf8");

// Функцию забора читаем через typeof: пока её нет в коде, харнесс обязан
// показать провал «нет fetchSourceText», а не упасть с ReferenceError — иначе
// непонятно, тест не работает или работает и ловит отсутствие фичи.
const api = new Function(
  "chrome",
  SRC_TEXT +
    '\nreturn { looksLikeHost, hostOf, DEFAULTS, fetchSourceText: typeof fetchSourceText === "function" ? fetchSourceText : null,' +
    // Пороги читаем как данные: тест сверяет поведение с числом из кода, а не с
    // числом, которое сам же и придумал.
    " SOURCE_MIN_CHARS: typeof SOURCE_MIN_CHARS === \"number\" ? SOURCE_MIN_CHARS : null," +
    " SOURCE_TIMEOUT_MS: typeof SOURCE_TIMEOUT_MS === \"number\" ? SOURCE_TIMEOUT_MS : null };"
)(chrome);

const { looksLikeHost, hostOf, DEFAULTS } = api;
const fetchSourceText = api.fetchSourceText;

// ------------------------------------------------------------- проверки
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, g === w ? "" : "получено " + g + ", ожидалось " + w);
}

/** Вызов, который должен упасть: возвращает текст ошибки или "". */
async function fails(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return (e && e.message) || String(e);
  }
}

function reset(article) {
  calls.created.length = 0;
  calls.removed.length = 0;
  calls.injected.length = 0;
  calls.permissions.length = 0;
  injectError = null;
  permissionAllowed = true;
  pageLoad = "complete";
  injectResult = article
    ? [{ result: article }]
    : [{ result: { html: "<p>Текст статьи.</p>", title: "Как выбирали", chars: 430 } }];
}

async function main() {
  // Функция обязана быть: без неё остальные проверки — не проверки.
  const have = typeof fetchSourceText === "function";
  check("воркер отдаёт функцию забора текста", have, have ? "" : "fetchSourceText не найдена в background.js");
  if (!have) {
    // Не падаем сразу: каждая идущая ниже проверка должна быть записана
    // проваленной, чтобы итог честно показывал, чего не хватает.
    const pending = [
      "голый хост дотягивается до https",
      "нельзя забирать не-адрес",
      "вкладка открывается в фоне",
      "успех: html, заголовок, адрес и число знаков",
      "вкладка закрыта после успеха"
    ];
    for (const name of pending) check(name, false, "нет fetchSourceText");
    report();
    return;
  }

  // ---- 1. адрес ------------------------------------------------------------
  reset();
  const opened = await fetchSourceText("auto-dom24.ru/article/1");
  eq("голый хост дотягивается до https", calls.created.length && calls.created[0].url, "https://auto-dom24.ru/article/1");
  check("адрес в ответе — тот, что открыли", opened && opened.url === "https://auto-dom24.ru/article/1", opened && opened.url);

  reset();
  const bad = await fails(fetchSourceText("это не адрес", {}));
  check("нельзя забирать не-адрес", bad !== null && /адрес/i.test(bad), "ошибка = " + JSON.stringify(bad));
  eq("не-адрес: вкладку не открывали", calls.created.length, 0);

  reset();
  const ftp = await fails(fetchSourceText("ftp://src.ru/a", {}));
  check("чужая схема отклоняется", ftp !== null, "ошибка = " + JSON.stringify(ftp));
  eq("чужая схема: вкладку не открывали", calls.created.length, 0);

  // Право на http в манифесте выдано только localhost и 127.0.0.1. На прочий
  // http вкладка открылась бы, а впрыснуть текст было бы нечем — человек
  // получил бы подсказку «Разрешить доступ», которая ничего не разрешит.
  reset();
  const plainHttp = await fails(fetchSourceText("http://example.com/a", {}));
  check("http вне localhost отклоняется", plainHttp !== null && /https/.test(plainHttp), "ошибка = " + JSON.stringify(plainHttp));
  eq("http вне localhost: вкладку не открывали", calls.created.length, 0);

  reset();
  const localHttp = await fails(fetchSourceText("http://localhost:8787/a", {}));
  check("http на localhost проходит", localHttp === null, "ошибка = " + JSON.stringify(localHttp));
  eq("http на localhost: вкладка открыта по адресу как есть", calls.created.length && calls.created[0].url, "http://localhost:8787/a");

  // ---- 2. фоновая вкладка --------------------------------------------------
  reset();
  await fetchSourceText("https://src.ru/a/");
  eq("вкладка открывается в фоне", calls.created[0].active, false);
  eq("вкладка закрыта после успеха", calls.removed.length, 1);
  eq("закрыта ровно та вкладка, что открыли", calls.removed[0], calls.lastTabId);

  // ---- 3. успех ------------------------------------------------------------
  reset();
  const ok = await fetchSourceText("https://src.ru/a/");
  eq("успех: html, заголовок, адрес и число знаков", [ok.html, ok.title, ok.url, ok.chars], [
    "<p>Текст статьи.</p>",
    "Как выбирали",
    "https://src.ru/a",
    430
  ]);
  eq("впрыскивание в MAIN-мире страницы", calls.injected.length && calls.injected[0].world, "MAIN");

  // ---- 4. страница не догрузилась ----------------------------------------
  // Вкладку, которая висит, воркер обязан закрыть: иначе у пользователя их
  // накапливается по штук на каждую неудачную попытку.
  reset();
  pageLoad = "never";
  const slow = await fails(fetchSourceText("https://slow.ru/a", { timeoutMs: 30 }));
  check("таймаут назван по-человечески", slow !== null && /не догрузилась/.test(slow), "ошибка = " + JSON.stringify(slow));
  eq("по таймауту вкладку закрыли", calls.removed.length, 1);
  eq("по таймауту ничего не впрыскивали", calls.injected.length, 0);

  // ---- 5. отказа по правам хватает на понятную подсказку ------------------
  // `executeScript` не работает без права на хост, а попросить право из воркера
  // нельзя. Значит человек обязан получить ту же формулировку, что и при
  // перелинковке без доступа, — а не «Cannot access a chrome-extension:// URL».
  reset();
  injectError = "Cannot access a chrome-extension:// URL of different extension";
  const denied = await fails(fetchSourceText("https://src.ru/a/"));
  check("отказ впрыскивания объясняет, что нажать", denied !== null && /«Разрешить доступ к сайтам»/.test(denied),
    "ошибка = " + JSON.stringify(denied));

  reset();
  injectError = "Cannot access a chrome-extension:// URL of different extension";
  let flagged = null;
  try {
    await fetchSourceText("https://src.ru/a/");
  } catch (e) {
    flagged = e;
  }
  check("отказ помечен признаком нехватки доступа", !!(flagged && flagged.needPermission), flagged && String(flagged.message));
  eq("после отказа вкладка закрыта", calls.removed.length, 1);

  // ---- 6. страница есть, текста нет ---------------------------------------
  // Заглушка антибота и paywall выглядят как страница: ловятся тем же порогом,
  // что и «это редактор» в панели. Молча вставить 50 знаков — испортить статью.
  reset();
  await fetchSourceText("https://src.ru/a/");
  const minChars = api.SOURCE_MIN_CHARS;
  check("порог длины текста задан", typeof minChars === "number" && minChars > 0, "SOURCE_MIN_CHARS = " + JSON.stringify(minChars));
  if (typeof minChars === "number") {
    reset({ html: "<p>" + "коротко. ".repeat(3) + "</p>", title: "Заглушка", chars: Math.floor(minChars / 2) });
    const tiny = await fails(fetchSourceText("https://src.ru/a/"));
    check("текст короче порога назван не статьёй", tiny !== null && /не статья|похоже/i.test(tiny), "ошибка = " + JSON.stringify(tiny));
    eq("короткий текст: вкладка закрыта", calls.removed.length, 1);

    reset({ html: "<p>нормальный текст статьи.</p>", title: "Статья", chars: minChars });
    const exact = await fails(fetchSourceText("https://src.ru/a/"));
    check("текст ровно по порогу проходит", exact === null, "ошибка = " + JSON.stringify(exact));
  }

  // ---- 7. отмена пользователем --------------------------------------------
  reset();
  pageLoad = "never";
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("cancel")), 20);
  const cancelled = await fails(fetchSourceText("https://src.ru/a/", { signal: ac.signal, timeoutMs: 5000 }));
  check("отмена названа отменой", cancelled !== null && /отмен/i.test(cancelled), "ошибка = " + JSON.stringify(cancelled));
  eq("отмена закрыла вкладку", calls.removed.length, 1);

  // Отмена, пришедшая ДО старта, — та же отмена: панель различает их по
  // признаку `cancelled`, и без него человек увидит красную ошибку.
  reset();
  pageLoad = "never";
  const pre = new AbortController();
  pre.abort();
  let preErr = null;
  try {
    await fetchSourceText("https://src.ru/a/", { signal: pre.signal, timeoutMs: 5000 });
  } catch (e) {
    preErr = e;
  }
  check("отмена до старта помечена признаком отмены", !!(preErr && preErr.cancelled), preErr && String(preErr.message));
  eq("отмена до старта закрыла вкладку", calls.removed.length, 1);

  report();
}

function report() {
  const failed = results.filter((r) => !r.ok).length;
  console.log("");
  console.log("всего проверок: " + results.length + ", провалов: " + failed);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error("Харнесс упал:", (e && e.stack) || e);
  process.exitCode = 1;
});
