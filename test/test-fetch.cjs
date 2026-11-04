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
// Хранилище сеанса: в нём воркер оставляет номера своих вкладок, чтобы уборка
// нашла хвосты, даже если процесс убили посреди забора.
const sessionStore = {};
// Что воркер писал в хранилище сеанса: по этим записям видно, что вкладку
// поставили на учёт до того, как её закрыли.
const sessionWrites = [];
// Общая лента «закрытие вкладки / запись учёта». Два разных массива порядка не
// дают, а порядок тут — предмет проверки: воркер MV3 умирает именно между этими
// двумя операциями, и по раздельным спискам не видно, что осталось — открытая
// вкладка без учёта или закрытая вкладка в списке.
const journal = [];
const calls = { created: [], removed: [], injected: [], permissions: [] };
let updatedListeners = [];
let injectResult = null; // что вернёт chrome.scripting.executeScript
let injectError = null; // или бросит
let permissionAllowed = true;
let nextTabId = 100;
// Как ведёт себя страница во вкладке: "complete" — догрузилась сразу,
// "never" — висит (проверка таймаута), "manual" — дожидается вызова из теста.
let pageLoad = "complete";
// Вкладки, живущие в «браузере»: по ним уборка проверяет, не смотрит ли
// человек в эту вкладку.
const tabsById = new Map();

/** Номер вкладки, оставленный прошным прогоном: её надо закрыть как сироту. */
function orphanTab(id, props = {}) {
  tabsById.set(id, { id, active: false, windowId: 1, ...props });
  sessionStore.dzrSourceTabs = [id];
  return id;
}

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
    },
    session: {
      get: async (d) => ({ ...d, ...sessionStore }),
      set: async (o) => {
        sessionWrites.push({ ...o });
        journal.push("учёт " + JSON.stringify(o.dzrSourceTabs));
        Object.assign(sessionStore, o);
      },
      remove: async (k) => { delete sessionStore[k]; }
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
      const tab = { id: nextTabId++, windowId: 1, active: !!props.active, url: props.url };
      tabsById.set(tab.id, tab);
      calls.created.push(props);
      calls.lastTabId = tab.id;
      // Страница не успевает догрузиться до того, как воркер подписался на
      // события: событие уходит следующим маком, как в настоящем Chrome.
      if (pageLoad === "complete") setImmediate(() => completeTab());
      return tab;
    },
    get: async (id) => {
      const tab = tabsById.get(id);
      if (!tab) throw new Error("No tab with id: " + id);
      return tab;
    },
    remove: async (ids) => {
      calls.removed.push(ids);
      journal.push("закрытие " + JSON.stringify([].concat(ids)));
      for (const id of [].concat(ids)) tabsById.delete(id);
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
    " SOURCE_TIMEOUT_MS: typeof SOURCE_TIMEOUT_MS === \"number\" ? SOURCE_TIMEOUT_MS : null," +
    // Внутренности учёта вкладок наружу: гонку «уборка прочитала список ДО того,
    // как соседний забор вписал свою вкладку» извне не смоделировать — она
    // живёт в порядке двух записей, а их тест видит только через эти ссылки.
    " reapOrphanSourceTabs: typeof reapOrphanSourceTabs === \"function\" ? reapOrphanSourceTabs : null," +
    " liveSourceTabs: typeof liveSourceTabs === \"object\" ? liveSourceTabs : null," +
    " keptSourceTabs: typeof keptSourceTabs === \"object\" ? keptSourceTabs : null };"
)(chrome);

const { looksLikeHost, hostOf, DEFAULTS } = api;
const fetchSourceText = api.fetchSourceText;
// Учёт вкладок: уборка и её наборы нужны тесту напрямую — см. пояснение там,
// где они выгружаются из background.js.
const reapOrphanSourceTabs = api.reapOrphanSourceTabs;
const liveSourceTabs = api.liveSourceTabs;
const keptSourceTabs = api.keptSourceTabs;

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
  delete sessionStore.dzrSourceTabs;
  sessionWrites.length = 0;
  journal.length = 0;
  tabsById.clear();
  // Наборы учёта живут внутри загруженного background.js и между подтестами
  // переносятся: без этой очистки следующий подтест видит чужую «активную
  // сироту» и PASS, которого на самом деле не было.
  if (liveSourceTabs) liveSourceTabs.clear();
  if (keptSourceTabs) keptSourceTabs.clear();
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
  // Мир впрыска — не деталь реализации, а граница безопасности: в MAIN-мире
  // сама страница вправе подменить cloneNode или геттер innerHTML и вернуть
  // произвольную разметку, которая затем попадает в предпросмотр и в статью.
  eq("разбор чужой страницы идёт в изолированном мире", calls.injected.length && calls.injected[0].world, "ISOLATED");

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

  // ---- 8. вкладки-сироты --------------------------------------------------
  // Воркер MV3 убивается посреди забора, и его `finally` уже не работает:
  // фоновая вкладка остаётся открытой навсегда. Номер остаётся в хранилище
  // сеанса, и следующий забор обязан убрать хвост — но не вкладку, которую
  // человек читает сам, и не вкладку идущего рядом забора.
  {
    const tick = async (n) => {
      for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
    };

    reset();
    await fetchSourceText("https://src.ru/a/");
    const marked = sessionWrites.some((w) => Array.isArray(w.dzrSourceTabs) && w.dzrSourceTabs.includes(calls.lastTabId));
    check("вкладка забора помечена в хранилище сеанса", marked, "записи: " + JSON.stringify(sessionWrites));
    eq("после успешного забора учёт пуст", sessionStore.dzrSourceTabs, []);

    // Порядок в ленте: вкладка обязана быть ЗАКРЫТА до последней записи, которая
    // снимает её с учёта. В обратном порядке между этими двумя операциями
    // попадает разрыв, а воркер MV3 убивают именно в разрыве: вкладка остаётся
    // открытой и уже не числится — следующая уборка её не найдёт.
    const closeAt = journal.findIndex((e) => e.indexOf("закрытие") === 0);
    const lastMark = journal.length - 1 - journal.slice().reverse().findIndex((e) => e.indexOf("учёт") === 0);
    check("вкладку закрыли до того, как снять с учёта", closeAt >= 0 && closeAt < lastMark, journal.join(" | "));

    reset();
    const orphan = orphanTab(777);
    await fetchSourceText("https://src.ru/a/");
    check("сирота с прошлого прогона закрыта", calls.removed.includes(orphan), "закрыто: " + JSON.stringify(calls.removed));
    check("сирота снята с учёта", !(sessionStore.dzrSourceTabs || []).includes(orphan), JSON.stringify(sessionStore.dzrSourceTabs));

    reset();
    const read = orphanTab(888, { active: true });
    await fetchSourceText("https://src.ru/a/");
    check("вкладку, которую читают, уборка не трогает", !calls.removed.includes(read), "закрыто: " + JSON.stringify(calls.removed));
    // Не закрыла — и НЕ забыла. Снятая с учёта активная вкладка больше никогда
    // сюда не попадёт: человек её дочитает, она останется висеть в окне, а
    // уборка будет считать, что хвостов нет.
    check("активную сироту уборка продолжила помнить", (sessionStore.dzrSourceTabs || []).includes(read), JSON.stringify(sessionStore.dzrSourceTabs));

    // Снимок уборки устарел: соседний забор вписал свою вкладку ПОСЛЕ того, как
    // уборка прочитала список. Запись обязана быть объединением известного, а не
    // фильтром снимка, — иначе живая вкладка исчезает из учёта, пока её забор
    // ещё ждёт загрузки, и убийство воркера в этом окне оставляет хвост навсегда.
    reset();
    const stale = orphanTab(911);
    liveSourceTabs.add(60600);
    await reapOrphanSourceTabs();
    liveSourceTabs.delete(60600);
    check("сирота из устаревшего снимка закрыта", calls.removed.includes(stale), "закрыто: " + JSON.stringify(calls.removed));
    check("вкладка живого забора не исчезла из учёта", (sessionStore.dzrSourceTabs || []).includes(60600), JSON.stringify(sessionStore.dzrSourceTabs));

    // Две вкладки живого воркера: уборка обязана знать о соседнем заборе.
    reset();
    pageLoad = "manual";
    const aP = fetchSourceText("https://a.ru/x");
    await tick(6);
    const aTab = calls.lastTabId;
    check("вкладка идущего забора помечена", (sessionStore.dzrSourceTabs || []).includes(aTab), JSON.stringify(sessionStore.dzrSourceTabs));
    const bP = fetchSourceText("https://b.ru/x");
    await tick(6);
    eq("чужой забор не закрыл вкладку соседнего", calls.removed.length, 0);
    const bTab = calls.lastTabId;
    fireUpdated(aTab, { status: "complete" });
    fireUpdated(bTab, { status: "complete" });
    await Promise.all([aP, bP]);
    eq("каждая вкладка закрыта своим забором", calls.removed.slice().sort((x, y) => x - y), [aTab, bTab].sort((x, y) => x - y));
    eq("после двух заборов учёт пуст", sessionStore.dzrSourceTabs, []);
  }

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
