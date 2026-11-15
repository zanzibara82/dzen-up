/**
 * Юнит-тест логики надёжности перевода (background.js) без сети.
 * background.js — не модуль, поэтому грузим его как тело функции с подставным chrome.
 */
const fs = require("fs");
const path = require("path");
const PATHS = require("./paths.cjs");

const SRC = path.join(PATHS.REPO, "src", "extension-src", "background.js");

// ------------------------------------------------------------- подставной chrome
const localStore = {};
// Медленная запись в хранилище: на ней видно, что происходит, когда человек
// жмёт «Очистить кэш» посреди сохранения переводов.
let slowWriteMs = 0;
const storeOps = [];
// Что показывает chrome.runtime.getManifest().version. Обновление сравнивает
// установленную версию с той, что лежит в main на GitHub, и обе стороны должны
// быть подставляемыми: иначе «локальная версия новее» пришлось бы подстраивать
// под содержимое манифеста в репозитории, а это проверка, которая краснеет сама.
let manifestVersion = "2.1.1";
const chrome = {
  storage: {
    sync: { get: async (d) => ({ ...d }), set: async () => {} },
    local: {
      get: async (d) => ({ ...d, ...localStore }),
      set: async (o) => {
        storeOps.push("set");
        if (slowWriteMs) await sleep(slowWriteMs);
        Object.assign(localStore, o);
      },
      remove: async (k) => {
        storeOps.push("remove");
        delete localStore[k];
      }
    }
  },
  runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, getManifest: () => ({ version: manifestVersion }) },
  contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  tabs: { sendMessage: async () => {}, query: async () => [] },
  windows: {
    create: async () => ({ id: 1 }),
    update: async () => ({}),
    onRemoved: { addListener() {} }
  }
};

const src = fs.readFileSync(SRC, "utf8");
const api = new Function(
  "chrome",
  src +
    "\nreturn { translateText, splitChunks, fetchJson, mapPool, clearCache, hashStr, " +
    "looksLikeTargetLang, myMemoryTranslate, DEFAULTS, " +
    // Потолок читаем как данные: тест сверяет поведение с числом из кода, а не
    // с числом, которое сам же и придумал.
    " API_MAX_BYTES: typeof API_MAX_BYTES === \"number\" ? API_MAX_BYTES : null, " +
    // Проверка обновлений: функции читаем как данные — отсутствующая функция
    // должна дать чистый провал проверки, а не уронить харнесс на ReferenceError.
    ' compareVersions: typeof compareVersions === "function" ? compareVersions : null, ' +
    ' checkUpdate: typeof checkUpdate === "function" ? checkUpdate : null, ' +
    ' UPDATE_MANIFEST_URL: typeof UPDATE_MANIFEST_URL === "string" ? UPDATE_MANIFEST_URL : null, ' +
    ' UPDATE_BUILD_COMMAND: typeof UPDATE_BUILD_COMMAND === "string" ? UPDATE_BUILD_COMMAND : null };'
)(chrome);
const {
  translateText,
  splitChunks,
  fetchJson,
  mapPool,
  clearCache,
  hashStr,
  looksLikeTargetLang,
  myMemoryTranslate,
  DEFAULTS,
  API_MAX_BYTES,
  compareVersions,
  checkUpdate,
  UPDATE_MANIFEST_URL,
  UPDATE_BUILD_COMMAND
} = api;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// сборка частей в кусок добавляет лишние пробелы — сравниваем по сути текста
const squash = (s) => String(s).replace(/\s+/g, "");

const SETTINGS = { sourceLang: "auto", targetLang: "ru", engine: "google" };

// ------------------------------------------------------------- подставной fetch
let routes = {};
const calls = [];
function installFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    const host = /translate\.googleapis\.com/.test(url) ? "google" : /mymemory/.test(url) ? "mymemory" : "other";
    const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || "");
    calls.push({ host, q });
    const handler = routes[host];
    const r = typeof handler === "function" ? await handler({ url, q, opts, n: calls.length }) : handler;
    if (!r) return jsonRes({});
    if (r.status && r.status !== 200) return plainRes(r.status, r.headers || {});
    if (r.throw) throw new Error(r.throw);
    return jsonRes(r.body);
  };
}
function jsonRes(body) {
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
function plainRes(status, headers) {
  return {
    ok: false, status, headers: { get: (k) => headers[k.toLowerCase()] || null },
    json: async () => ({}),
    text: async () => ""
  };
}
function googleBody(text) {
  return [text.split(/(?<=[.!?…])\s+/).filter(Boolean).map((s) => [s, s, null, null])];
}
function mmBody(text) {
  return { responseStatus: 200, responseData: { translatedText: text } };
}

/** id расширения, который подставляет макет и который ждут в sender. */
const EXT_ID = "dzrextensionid";

/**
 * Подставной chrome для прогонов через настоящий обработчик сообщений: воркер
 * грузится заново, а его слушатель попадает в `box`. Каждому прогону нужен
 * свежий экземпляр — иначе состояния модуля перемешаются.
 */
function mockWorkerChrome(box, store = {}) {
  return {
    storage: {
      sync: { get: async (d) => ({ ...d }), set: async () => {} },
      local: { get: async (d) => ({ ...d, ...store }), set: async () => {}, remove: async () => {} }
    },
    runtime: {
      // id воркеру нужен, чтобы опознать своего отправителя: Chrome ставит в
      // sender.id id того же расширения, и сверка идёт по нему, а не по одному
      // лишь виду адреса.
      id: EXT_ID,
      getURL: (p) => "chrome-extension://" + EXT_ID + "/" + (p || ""),
      onMessage: { addListener: (fn) => { box.listener = fn; } }, onInstalled: { addListener() {} },
      getManifest: () => ({ version: manifestVersion })
    },
    contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener: (fn) => { box.command = fn; } } },
    tabs: {
      sendMessage: async () => {},
      query: async () => [],
      create: async () => ({ id: 1 }),
      remove: async () => {},
      onUpdated: { addListener: (fn) => { box.tabUpdated = fn; }, removeListener: () => {} },
      onRemoved: { addListener: (fn) => { box.tabRemoved = fn; } },
      update: async () => {}
    },
    permissions: { contains: async () => true, request: async () => true },
    scripting: { executeScript: async () => [{ result: null }] },
    action: { badgeText: { set: async () => {} } },
    windows: {
      create: async () => ({ id: 1 }),
      update: async () => ({}),
      onRemoved: { addListener() {} }
    }
  };
}

// ------------------------------------------------------------------- прогоны
async function main() {
  installFetch();

  console.log("=== 1. splitChunks ===");
  {
    const chunks = splitChunks("Раз. Два! Три? Четыре.", 8);
    check("режет по границам предложений", chunks.every((c) => c.length <= 8) && chunks.length >= 2, JSON.stringify(chunks));
    check("не теряет текст", chunks.join("").replace(/\s+/g, "") === "Раз.Два!Три?Четыре.", chunks.join("|"));
    const huge = splitChunks("x".repeat(25), 10);
    check("режет сверхдлинное предложение", huge.length === 3 && huge.join("").length === 25, JSON.stringify(huge.length));
  }

  console.log("\n=== 2. Обычный перевод: абзацы, статистика ===");
  {
    await clearCache();
    calls.length = 0;
    routes = {
      google: ({ q }) => ({ body: googleBody(q.toUpperCase()) }),
      mymemory: ({ q }) => ({ body: mmBody(q) })
    };
    const text = "Первый абзац.\n\nВторой абзац.";
    const res = await translateText(text, SETTINGS);
    check("текст переведён", res.text === "ПЕРВЫЙ АБЗАЦ.\n\nВТОРОЙ АБЗАЦ.", JSON.stringify(res.text));
    check("абзацы сохранены (\\n\\n)", res.text.includes("\n\n"));
    check("stats: total=2, done=2", res.stats.total === 2 && res.stats.done === 2, JSON.stringify(res.stats));
    check("stats: без кэша и фолбэка", res.stats.cached === 0 && res.stats.fellBack === 0 && res.stats.failed === 0);
    check("stats: percent=100", res.stats.percent === 100);
  }

  console.log("\n=== 3. Кэш: второй прогон не ходит в сеть ===");
  {
    calls.length = 0;
    const res = await translateText("Первый абзац.\n\nВторой абзац.", SETTINGS);
    check("всё взято из кэша", res.stats.cached === 2, JSON.stringify(res.stats));
    check("в сеть не ходили", calls.length === 0, "запросов: " + calls.length);
    check("текст тот же", res.text === "ПЕРВЫЙ АБЗАЦ.\n\nВТОРОЙ АБЗАЦ.", JSON.stringify(res.text));
  }

  console.log("\n=== 4. Повтор на 429, потом успех ===");
  {
    await clearCache();
    let n = 0;
    const seen = [];
    routes = {
      google: ({ q }) => {
        n++;
        seen.push(n);
        if (n <= 2) return { status: 429, headers: { "retry-after": "0" } };
        return { body: googleBody(q.toUpperCase()) };
      },
      mymemory: ({ q }) => ({ body: mmBody(q) })
    };
    const t0 = Date.now();
    const res = await translateText("Тестовый кусок.", SETTINGS);
    const ms = Date.now() - t0;
    check("повторил и добился успеха", res.text === "ТЕСТОВЫЙ КУСОК.", JSON.stringify(res.text));
    check("было ровно 3 попытки", n === 3, "попыток: " + n);
    check("фолбэк не понадобился", res.stats.fellBack === 0 && res.stats.failed === 0, JSON.stringify(res.stats));
    console.log("   (заняло %d мс с паузами между повторами)", ms);
  }

  console.log("\n=== 5. 500 на первом движке → видимый фолбэк ===");
  {
    await clearCache();
    routes = {
      google: () => ({ status: 503 }),
      mymemory: ({ q }) => ({ body: mmBody("MM:" + q) })
    };
    // Исходный язык обязан быть назван: MyMemory не определяет язык, и при
    // auto он отказывает (проверка отказа — в разделе 21).
    const res = await translateText("Кусок текста.", { ...SETTINGS, sourceLang: "en" });
    check("текст получен со второго движка", res.text === "MM:Кусок текста.", JSON.stringify(res.text));
    check("stats.fellBack = 1", res.stats.fellBack === 1, JSON.stringify(res.stats));
    check("stats.failed = 0", res.stats.failed === 0);
    check("stats называет движки", res.stats.engine === "Google" && res.stats.fallbackName === "MyMemory", JSON.stringify(res.stats));
  }

  console.log("\n=== 6. Оба движка мертвы на одном куске из двух ===");
  {
    await clearCache();
    routes = {
      // падает только второй кусок; первый переводится нормально
      google: ({ q }) => (q.includes("ЖИВОЙ") ? { body: googleBody(q.toUpperCase()) } : { status: 500 }),
      mymemory: () => ({ status: 500 })
    };
    let res = null;
    let err = null;
    try {
      res = await translateText("ЖИВОЙ кусок.\n\nМёртвый кусок.", SETTINGS);
    } catch (e) {
      err = e;
    }
    check("не бросил исключение", !err, err ? String(err.message || err) : "исключения нет");
    check("stats.failed = 1", !!res && res.stats.failed === 1, res ? JSON.stringify(res.stats) : "результата нет");
    check("непереведённый кусок оставлен как есть", !!res && res.text.includes("Мёртвый кусок."), res ? JSON.stringify(res.text) : "результата нет");
    check("остальное переведено", !!res && res.text.includes("ЖИВОЙ КУСОК."), res ? JSON.stringify(res.text) : "результата нет");
  }

  console.log("\n=== 7. Мертвы ВСЕ куски → явная ошибка ===");
  {
    await clearCache();
    routes = { google: () => ({ status: 500 }), mymemory: () => ({ status: 500 }) };
    let err = null;
    try {
      await translateText("Раз. Два.", SETTINGS);
    } catch (e) {
      err = e;
    }
    check("брошено исключение", !!err, err && err.message);
    check("сообщение понятное", !!err && /недоступен/i.test(err.message), err && err.message);
  }

  console.log("\n=== 8. Отмена ===");
  {
    await clearCache();
    routes = { google: async ({ q }) => { await sleep(300); return { body: googleBody(q) }; } };
    const ac = new AbortController();
    const p = translateText("Долгий кусок текста.", SETTINGS, { signal: ac.signal });
    await sleep(60);
    ac.abort();
    let err = null;
    try { await p; } catch (e) { err = e; }
    check("отмена бросила AbortError", !!err && err.name === "AbortError", err && err.name);
    check("ошибка помечена cancelled", !!err && err.cancelled === true);
  }

  console.log("\n=== 9. Параллельность ===");
  {
    await clearCache();
    let inFlight = 0, peak = 0;
    routes = {
      google: async ({ q }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(120);
        inFlight--;
        return { body: googleBody(q) };
      }
    };
    const paras = Array.from({ length: 8 }, (_, i) => "Кусок номер " + i + ".").join("\n\n");
    const t0 = Date.now();
    await translateText(paras, SETTINGS);
    const ms = Date.now() - t0;
    check("работает параллельно (пик > 1)", peak > 1, "пик: " + peak);
    check("не превышает лимит 4", peak <= 4, "пик: " + peak);
    check("быстрее последовательного", ms < 8 * 120, ms + " мс против " + 8 * 120 + " мс последовательно");
  }

  console.log("\n=== 10. Прогресс ===");
  {
    await clearCache();
    routes = { google: async ({ q }) => { await sleep(30); return { body: googleBody(q) }; } };
    const seen = [];
    const paras = Array.from({ length: 5 }, (_, i) => "Абзац " + i + ".").join("\n\n");
    await translateText(paras, SETTINGS, { onProgress: (p) => seen.push(p.percent) });
    check("прогресс доходит до 100", seen[seen.length - 1] === 100, JSON.stringify(seen));
    check("прогресс монотонный", seen.every((v, i) => i === 0 || v >= seen[i - 1]), JSON.stringify(seen));
    check("есть промежуточные значения", seen.length > 2, JSON.stringify(seen));
  }

  console.log("\n=== 11. mapPool ===");
  {
    const out = await mapPool([5, 1, 3], 2, async (x) => x * 2);
    check("сохраняет порядок", JSON.stringify(out) === "[10,2,6]", JSON.stringify(out));
    let err = null;
    try {
      await mapPool([1, 2, 3, 4], 2, async (x) => { if (x === 2) throw new Error("бум"); return x; });
    } catch (e) { err = e; }
    check("пробрасывает ошибку", !!err && err.message === "бум");
  }

  console.log("\n=== 12. fetchJson: 4xx не повторяем ===");
  {
    let n = 0;
    globalThis.fetch = async () => { n++; return plainRes(404, {}); };
    let err = null;
    try { await fetchJson("http://x/y", { label: "Тест" }); } catch (e) { err = e; }
    check("404 бросил ошибку", !!err && /404/.test(err.message), err && err.message);
    check("повторов не было", n === 1, "запросов: " + n);
  }

  console.log("\n=== 13. Определение «уже на целевом языке» ===");
  {
    const RU =
      "Автомобиль оснащён оппозитным двигателем и новыми амортизаторами, " +
      "которые были разработаны специально для этой модели.";
    const RU_SHORT = "Мы были там и видели всё своими глазами.";
    const UK =
      "Автомобіль оснащений опозитним двигуном і новими амортизаторами, " +
      "які були розроблені спеціально для цієї моделі.";
    const BE =
      "Аўтамабіль абсталяваны апазітным рухавіком і новымі амартызатарамі, " +
      "якія былі распрацаваны спецыяльна для гэтай мадэлі.";
    const BG =
      "Автомобилът е оборудван с боксеров двигател и нови амортисьори, " +
      "които бяха разработени специално за този модел.";
    const SR =
      "Аутомобил је опремљен боксер мотором и новим амортизерима, " +
      "који су развијени специјално за овај модел.";
    const EN =
      "The car has a boxer engine and the new dampers, which were developed " +
      "for this model and are available from the factory.";
    const FR =
      "La voiture est équipée d'un moteur boxer et de nouveaux amortisseurs, " +
      "qui ont été développés pour ce modèle et sont disponibles.";
    const DE =
      "Das Auto ist mit einem Boxermotor und neuen Dämpfern ausgestattet, " +
      "die für dieses Modell entwickelt wurden und ab Werk erhältlich sind.";
    const EL = "Το αυτοκίνητο είναι εξοπλισμένο με κινητήρα μπόξερ και νέα αμορτισέρ.";
    const HE = "המכונית מצוידת במנוע בוקסר ובבולמי זעזועים חדשים שפותחו במיוחד לדגם הזה.";
    const AR = "السيارة مجهزة بمحرك بوكسر وممتصات صدمات جديدة تم تطويرها لهذا الطراز.";
    const HI = "कार में बॉक्सर इंजन और नए डैम्पर लगे हैं जो इस मॉडल के लिए बनाए गए हैं।";
    const TH = "รถคันนี้ติดตั้งเครื่องยนต์บอกเซอร์และโช้คอัพใหม่ที่พัฒนาสำหรับรุ่นนี้โดยเฉพาะ";
    const KO = "이 차에는 복서 엔진과 새로운 댐퍼가 장착되어 있으며 이 모델을 위해 개발되었습니다.";
    const JA = "この車にはボクサーエンジンと新しいダンパーが搭載されており、このモデル用に開発されました。";
    const ZH = "这辆车配备了水平对置发动机和新的减震器，它们是专门为这个车型开发的。";
    const MIXED =
      "Обзор Subaru Outback Wilderness: boxer engine, 9.5 inches of ground " +
      "clearance and the new dampers for the 2026 model year are here.";

    check("русский → уже русский", looksLikeTargetLang(RU, "ru") === true);
    check("короткий русский → тоже", looksLikeTargetLang(RU_SHORT, "ru") === true);
    check("украинский НЕ считается русским", looksLikeTargetLang(UK, "ru") === false);
    check("белорусский НЕ считается русским", looksLikeTargetLang(BE, "ru") === false);
    check("болгарский НЕ считается русским", looksLikeTargetLang(BG, "ru") === false);
    check("сербский НЕ считается русским", looksLikeTargetLang(SR, "ru") === false);
    check("украинский → уже украинский", looksLikeTargetLang(UK, "uk") === true);
    check("русский НЕ считается украинским", looksLikeTargetLang(RU, "uk") === false);
    check("английский → уже английский", looksLikeTargetLang(EN, "en") === true);
    check("французский НЕ считается английским", looksLikeTargetLang(FR, "en") === false);
    check("французский → уже французский", looksLikeTargetLang(FR, "fr") === true);
    check("английский НЕ считается французским", looksLikeTargetLang(EN, "fr") === false);
    check("немецкий → уже немецкий", looksLikeTargetLang(DE, "de") === true);
    check("греческий → уже греческий", looksLikeTargetLang(EL, "el") === true);
    check("иврит → уже иврит", looksLikeTargetLang(HE, "he") === true);
    check("арабский → уже арабский", looksLikeTargetLang(AR, "ar") === true);
    check("хинди → уже хинди", looksLikeTargetLang(HI, "hi") === true);
    check("тайский → уже тайский", looksLikeTargetLang(TH, "th") === true);
    check("корейский → уже корейский", looksLikeTargetLang(KO, "ko") === true);
    check("японский → уже японский", looksLikeTargetLang(JA, "ja") === true);
    check("китайский → уже китайский", looksLikeTargetLang(ZH, "zh") === true);
    check("японский НЕ считается китайским", looksLikeTargetLang(JA, "zh") === false);
    check("китайский НЕ считается японским", looksLikeTargetLang(ZH, "ja") === false);
    check("смешанный русско-английский НЕ пропускаем", looksLikeTargetLang(MIXED, "ru") === false);
    check("английский с русской целью НЕ пропускаем", looksLikeTargetLang(EN, "ru") === false);

    check("короткий фрагмент не оцениваем", looksLikeTargetLang("OK", "en") === false);
    check("маркеры без букв не считаются текстом", looksLikeTargetLang("[[1]] [[2]] [[3]]", "ru") === false);
    check("числа без букв не считаются текстом", looksLikeTargetLang("3 500 000 000 000 000 000 000 000", "ru") === false);
    check("неизвестный язык не пропускаем", looksLikeTargetLang(RU, "sw") === false);
    check("пустой целевой язык не пропускаем", looksLikeTargetLang(RU, "") === false);
    check("регистр и хвост локали не мешают", looksLikeTargetLang(ZH, "zh-CN") === true && looksLikeTargetLang(EN, "EN") === true);
  }

  console.log("\n=== 14. Пропуск фрагментов в переводе ===");
  {
    // Раздел 12 подменил globalThis.fetch своим счётчиком, а кэш живёт на весь
    // прогон: возвращаем записывающий fetch и начинаем с пустого кэша, иначе
    // проверки зависят от предыдущих разделов.
    installFetch();
    await clearCache();

    const RU =
      "Автомобиль оснащён опозитным двигателем и новыми амортизаторами, " +
      "которые были разработаны специально для этой модели.";
    const EN =
      "The car has a boxer engine and the new dampers, which were developed " +
      "for this model and are available from the factory.";

    // 1) всё уже на русском — в сеть не идём вообще
    calls.length = 0;
    routes = { google: async ({ q }) => ({ body: googleBody(q) }) };
    let res = await translateText(RU, { ...SETTINGS, skipSameLang: true });
    check("русский текст при цели ru: запросов нет", calls.length === 0, "запросов: " + calls.length);
    check("статистика отметила пропуск", res.stats.skipped === res.stats.total && res.stats.total > 0, JSON.stringify({ skipped: res.stats.skipped, total: res.stats.total }));
    check("текст вернулся без изменений", res.text === RU, JSON.stringify(res.text.slice(0, 40)));
    check("пропущенное не считается кэшем и не считается ошибкой", res.stats.cached === 0 && res.stats.failed === 0);

    // 2) выключенная настройка возвращает прежнее поведение
    calls.length = 0;
    res = await translateText(RU, { ...SETTINGS, skipSameLang: false });
    check("с выключенной настройкой текст переводится", calls.length > 0, "запросов: " + calls.length);
    check("и пропусков нет", res.stats.skipped === 0, "пропусков: " + res.stats.skipped);

    // 3) английский текст при цели ru переводится как обычно
    calls.length = 0;
    routes = { google: async ({ q }) => ({ body: googleBody("ПЕРЕВОД: " + q) }) };
    res = await translateText(EN, { ...SETTINGS, skipSameLang: true });
    check("английский текст при цели ru всё равно переводится", calls.length > 0 && res.stats.skipped === 0, "запросов: " + calls.length);
    check("перевод применился", /ПЕРЕВОД/.test(res.text), JSON.stringify(res.text.slice(0, 40)));

    // 4) смешанный текст: русские абзацы пропускаем, английский переводим
    calls.length = 0;
    res = await translateText(RU + "\n\n" + EN, { ...SETTINGS, skipSameLang: true });
    check("в смешанном тексте пропущен ровно русский абзац", res.stats.skipped === 1, JSON.stringify({ skipped: res.stats.skipped, total: res.stats.total }));
    check("английский абзац переведён", /ПЕРЕВОД/.test(res.text), JSON.stringify(res.text.slice(-60)));
    check("русский абзац остался как был", res.text.indexOf(RU) === 0, JSON.stringify(res.text.slice(0, 40)));
  }

  console.log("\n=== 15. Пресеты промпта (presets.js) ===");
  {
    // presets.js подключается в попап и контент-скрипт, но не в service worker,
    // поэтому грузим его отдельно: так проверка не зависит от того, кто первым
    // попросил настройки.
    const presetsSrc = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "presets.js"), "utf8");
    delete globalThis.DzenPresets;
    new Function(presetsSrc)();
    const P = globalThis.DzenPresets;

    check("presets.js отдал список пресетов", !!(P && Array.isArray(P.list) && P.list.length >= 5), "пресетов: " + ((P && P.list) || []).length);

    const list = (P && P.list) || [];
    const ids = list.map((p) => p.id);
    check("id пресетов уникальны", new Set(ids).size === ids.length, ids.join(","));
    check("пресет по умолчанию существует", !!(P && P.byId(P.DEFAULT_ID)), P && P.DEFAULT_ID);
    check("метка «свой промпт» существует", !!(P && P.byId(P.CUSTOM_ID)), P && P.CUSTOM_ID);

    const incomplete = list.filter((p) => !p.name || !p.short || !p.hint || (!p.custom && !p.prompt));
    check("у каждого пресета есть имя, короткая подпись, подсказка и текст", incomplete.length === 0, incomplete.map((p) => p.id).join(","));

    // Требования к тексту промпта — не вкусовщина, а условия работы пайплайна:
    // без запрета на комментарии модель пришлёт «Вот готовый текст:» в статью,
    // а результат вставляется как обычный текст, и markdown остался бы как есть.
    const chatty = list.filter((p) => !p.custom && !/без комментариев/i.test(p.prompt));
    check("каждый промпт запрещает комментарии", chatty.length === 0, chatty.map((p) => p.id).join(","));
    const marked = list.filter((p) => !p.custom && /markdown|##|\*\*/.test(p.prompt));
    check("промпты не просят разметки", marked.length === 0, marked.map((p) => p.id).join(","));

    // Главная страховка от расхождений: текст пресета по умолчанию обязан
    // совпадать с DEFAULTS.aiPrompt воркера. Иначе пользователь без сохранённых
    // настроек и пользователь, открывший попап, получали бы разный результат.
    const def = P && P.byId(P.DEFAULT_ID);
    check(
      "дефолтный промпт воркера совпадает с пресетом по умолчанию",
      !!def && DEFAULTS.aiPrompt === def.prompt,
      JSON.stringify({ воркер: String(DEFAULTS.aiPrompt).slice(0, 34), пресет: String(def && def.prompt).slice(0, 34) })
    );
    check("воркер знает id пресета по умолчанию", DEFAULTS.aiPreset === (P && P.DEFAULT_ID), String(DEFAULTS.aiPreset));

    // Промпт уезжает в chrome.storage.sync, где лимит 8 КБ на ключ. Если пресет
    // подберётся к границе, сохранение настроек начнёт падать на пустом месте.
    const fat = list.filter((p) => Buffer.byteLength(p.prompt, "utf8") > 4000);
    check("промпты заведомо влезают в лимит sync (8 КБ на ключ)", fat.length === 0, fat.map((p) => p.id).join(","));
  }

  console.log("\n=== 16. запись кэша не ждёт таймера ===");
  {
    // Воркер MV3 убивается в простое: не записанное — пропало. Кэш переводов
    // сохранялся паузой в 1,5 с после последнего фрагмента, и воркер,
    // дописавший статью и заснувший, терял готовые переводы. Проверка
    // требует: как только translate вернул ответ, запись уже в хранилище,
    // без ожидания дебаунса.
    // Фрагмент обязан быть НЕ на русском: русский при targetLang=ru считается
    // уже переведённым (job.same) и в кэш не пишется — проверка бы висела
    // вхолостую, без единого обращения к переводчику.
    await clearCache();
    routes = { google: ({ q }) => ({ body: googleBody(q.toUpperCase()) }) };
    await translateText("A fragment that must reach the storage.", SETTINGS);
    let landed = false;
    for (let i = 0; i < 24 && !landed; i++) {
      landed = Object.keys(localStore.dzrCache || {}).length > 0;
      if (!landed) await sleep(25);
    }
    check("кэш переводов пишется сразу, а не через паузу", landed, "не дождались записи за ~600 мс");
  }

  console.log("\n=== 17. висячий сайт: карта читается с таймаутом ===");
  {
    // fetchText — единственный сетевой путь без таймаута: сайт, принявший
    // запрос и замолчавший, вешает чтение карты навсегда, и сообщение
    // перелинковки остаётся без ответа. Чтобы не ждать реального потолка,
    // грузим background.js ещё раз с таймером, ускоренным в сто раз, и
    // ставим «сервер», который молчит вечно.
    const realST = setTimeout;
    const scaleST = (cb, ms) => realST(cb, Math.max(1, Math.round((ms || 0) / 100)));
    const api2 = new Function("chrome", "setTimeout", "clearTimeout", src + "\nreturn { sitemapFor };")(
      chrome,
      scaleST,
      clearTimeout
    );
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (url, opts = {}) =>
      new Promise((res, rej) => {
        // «сервер» принял соединение и замолчал: ни ответа, ни обрыва.
        // Ожить обещает только когда его оборвут по таймауту.
        const s = opts.signal;
        if (s) {
          if (s.aborted) { rej(new Error("abort")); return; }
          s.addEventListener("abort", () => rej(new Error("висячий ответ оборван")));
        }
      });
    const outcome = await Promise.race([
      api2.sitemapFor("https://hang.example/sitemap.xml", null, true).then(
        () => "done",
        () => "error"
      ),
      new Promise((r) => realST(() => r("hang"), 4000))
    ]);
    globalThis.fetch = prevFetch;
    check("висячий сайт не вешает чтение карты", outcome === "done", "исход: " + outcome);
  }

  console.log("\n=== 18. панель экранирует чужие строки в уведомлениях ===");
  {
    // toast() пишет сообщение в innerHTML. Значения, приехавшие извне — текст
    // ошибки (фон кладёт в него кусок тела ответа AI-сервиса), имена движков,
    // описание редактора со страницы — обязаны идти через escapeHtml, иначе
    // чужая разметка исполнится на dzen.ru. Проверка статическая и вычитает уже
    // закрытые escapeHtml-скобки, поэтому ловит именно «забыли экранировать», а
    // не просто ищет слово в файле.
    const csrc = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "content.js"), "utf8");
    const RISKY = ["err.message", "aiNote", "describeEditor(", "ts.engine", "ts.fallbackName"];

    function closeAt(text, open) {
      let depth = 0;
      for (let i = open; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    }
    function stripEscaped(text) {
      let out = "", i = 0;
      for (;;) {
        const at = text.indexOf("escapeHtml(", i);
        if (at === -1) { out += text.slice(i); break; }
        const end = closeAt(text, at + "escapeHtml(".length - 1);
        if (end === -1) { out += text.slice(i); break; }
        out += text.slice(i, at) + "«экранировано»";
        i = end + 1;
      }
      return out;
    }

    const bare = [];
    let at = -1;
    while ((at = csrc.indexOf("toast(", at + 1)) !== -1) {
      if (csrc.slice(Math.max(0, at - 9), at) === "function ") continue;
      const open = at + "toast".length;
      const end = closeAt(csrc, open);
      if (end === -1) continue;
      const call = csrc.slice(open, end + 1);
      const cleaned = stripEscaped(call);
      for (const r of RISKY) if (cleaned.indexOf(r) !== -1) bare.push(r);
    }
    check("в уведомлениях нет неэкранированных чужих строк", bare.length === 0, bare.join(", "));
    // заодно убеждаемся, что проверка не пустышка: без escapeHtml она обязана сработать
    const demo = stripEscaped("(\"❌ \" + err.message)");
    check("проверка видит голую вставку ошибки", demo.indexOf("err.message") !== -1, JSON.stringify(demo));
    const demo2 = stripEscaped("(\"❌ \" + escapeHtml(String((err && err.message) || err)))");
    check("проверка пропускает экранированную ошибку", demo2.indexOf("err.message") === -1, JSON.stringify(demo2));
  }

  console.log("\n=== 19. отмена в зазоре между фазами не запускает следующую ===");
  {
    // Прогон панели — это два сообщения под одним requestId: translate, затем
    // aiRewrite. Контроллер живёт только время фазы, и отмена, нажатая в паузе
    // между ними, раньше промахивалась: воркер отвечал «отменять нечего», и AI
    // стартовал уже после «Отменить» — статья переписывалась вопреки обещанию
    // README. Здесь мы прогоняем именно эту последовательность через обработчик
    // сообщений, с настоящим разбором ответа и счётчиком сетевых вызовов.
    const box = {};
    new Function("chrome", src)(mockWorkerChrome(box));
    const listener = box.listener;
    if (!listener) throw new Error("обработчик сообщений не подписан");

    const send = (msg) => new Promise((r) => listener(msg, {}, r));
    const aiSeen = () => calls.filter((c) => c.host === "other").length;

    routes.google = ({ q }) => ({ body: googleBody(q + " — перевод") });
    routes.other = () => ({ body: { choices: [{ message: { content: "переписала модель" } }] } });

    const tr = await send({ type: "translate", text: "привет мир.", requestId: "gap-1", overrides: { targetLang: "ru" } });
    check("первая фаза отработала", tr && tr.ok === true, JSON.stringify(tr && (tr.error || tr.text || "")).slice(0, 80));

    const cancel = await send({ type: "cancelTranslate", requestId: "gap-1" });
    check("отмена в зазоре засчитана, а не промахнулась", cancel && cancel.ok === true && cancel.cancelled === true, JSON.stringify(cancel));

    const before = aiSeen();
    const ai = await send({ type: "aiRewrite", text: "привет мир — перевод", requestId: "gap-1", overrides: { aiKey: "sk-test", aiModel: "m", aiPrompt: "перепиши" } });
    check("вторая фаза под отменённым id не стартовала", ai && ai.ok === false && ai.cancelled === true, JSON.stringify(ai));
    check("за отменённый прогон не ушло ни одного AI-запроса", aiSeen() === before, "запросов: " + (aiSeen() - before));

    // и проверим обратное: свежий id того же прогона работает как обычно
    const fresh = await send({ type: "aiRewrite", text: "привет мир — перевод", requestId: "gap-2", overrides: { aiKey: "sk-test", aiModel: "m", aiPrompt: "перепиши" } });
    check("обычный рерайт под новым id работает", fresh && fresh.ok === true && fresh.text === "переписала модель", JSON.stringify(fresh));
    check("для него запрос действительно был", aiSeen() === before + 1, "всего AI-вызовов: " + aiSeen());
  }

  console.log("\n=== 20. ответ не-JSON: одна ошибка и ни одного повтора ===");
  {
    // Сервис отвечает 200, а телом — HTML (антибот, captive portal, не тот путь
    // у aiBaseUrl). Проверим ровно два обещания: человек видит имя сервиса и
    // начало ответа, а не «Unexpected token», и что такой ответ не повторяется
    // попытками — иначе он бился бы по платному API ради мусора.
    const prevFetch = globalThis.fetch;
    let hits = 0;
    globalThis.fetch = async () => {
      hits++;
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => "<!DOCTYPE html><html><body>Access denied</body></html>",
        json: async () => { throw new SyntaxError('Unexpected token "<", "<!DOCTYP" is not valid JSON'); }
      };
    };
    let err = null;
    try {
      await fetchJson("https://api.openai.com/v1/chat/completions", { label: "AI", tries: 4, timeout: 500 });
    } catch (e) {
      err = e;
    }
    globalThis.fetch = prevFetch;
    check("отказ называет сервис и начало ответа", !!err && /^AI: сервис вернул не JSON/.test(err.message) && /Access denied/.test(err.message), err && err.message.slice(0, 90));
    check("не-JSON не повторяется попытками", hits === 1, "запросов: " + hits);
  }

  console.log("\n=== 21. фолбэк: свой лимит куска, свой ключ кэша и честный отказ при auto ===");
  {
    // Кусок режется по лимиту основного движка (у Google 1600 знаков). Когда
    // отвечает резервный, у которого лимит 480, целый кусок он отбрасывает с
    // «QUERY LENGTH LIMIT» — и панель выдаёт «сервис недоступен», хотя второй
    // переводчик жив. Плюс перевод резервного раньше ложно записывался в кэш
    // основного, и следующий прогон считал чужую работу своей.
    await clearCache();
    calls.length = 0;
    const text = "alpha beta gamma delta. ".repeat(40).trim();
    const whole = splitChunks(text, 1600);
    check("кусок один и он в лимите Google", whole.length === 1 && whole[0].length > 480 && whole[0].length <= 1600, "длина: " + whole[0].length);

    routes = {
      google: () => ({ status: 400 }),
      mymemory: ({ q }) => ({ body: mmBody(q.toUpperCase()) })
    };
    const res = await translateText(text, { ...SETTINGS, sourceLang: "en" });
    const mmCalls = calls.filter((c) => c.host === "mymemory");
    check("основной движок не вернул перевод", res.stats.fellBack === 1 && res.stats.failed === 0, JSON.stringify(res.stats));
    check("резервный получил не один большой кусок", mmCalls.length > 1, "кусков: " + mmCalls.length);
    check("каждый кусок в лимите резервного", mmCalls.every((c) => c.q.length <= 480), "макс: " + Math.max(...mmCalls.map((c) => c.q.length)));
    check("текст собран из частей", squash(res.text) === squash(mmCalls.map((c) => c.q.toUpperCase()).join("")), JSON.stringify(res.text).slice(0, 60));

    let keys = [];
    for (let i = 0; i < 24 && !keys.length; i++) {
      keys = Object.keys(localStore.dzrCache || {});
      if (!keys.length) await sleep(25);
    }
    check("кэш переводов заполнен", keys.length > 0, "ключей: " + keys.length);
    check("перевод резервного не притворяется переводом основного", keys.every((k) => k.indexOf("google|") !== 0), keys.join(" "));
    check("он лежит под ключом ответившего движка", keys.some((k) => k.indexOf("mymemory|en|ru|") === 0 && k.endsWith(hashStr(whole[0]))), keys.join(" "));

    // Обратный случай: язык источника не выбран. Резервный обязан отказаться, а
    // не переводить текст «как английский», и в сеть ему уходить незачем.
    await clearCache();
    calls.length = 0;
    routes = { google: () => ({ status: 400 }), mymemory: ({ q }) => ({ body: mmBody(q) }) };
    let err = null;
    try {
      await translateText("One more fragment.", SETTINGS);
    } catch (e) {
      err = e;
    }
    check("при auto резервный не вызывался", calls.filter((c) => c.host === "mymemory").length === 0, "всего вызовов: " + calls.length);
    check("отказ объясняет про язык источника", !!err && /язык/.test(err.message) && /MyMemory/.test(err.message), err && err.message);

    const direct = await myMemoryTranslate("whatever", "auto", "ru").catch((e) => e);
    check("при прямом вызове на auto отказ помечен", !!direct && direct.noSourceLang === true, String(direct && direct.message));
  }

  console.log("\n=== 22. перелинковка отменяется, а не дожидается чужих сайтов ===");
  {
    // Подбор ссылок — сетевой шаг: он обходит карты сайтов и канала. Пока он
    // висел без контроллера, кнопка «Отменить» его не касалась, и человек ждал
    // чужой сайт даже тогда, когда решил отменить прогон.
    const box = {};
    new Function("chrome", src)(mockWorkerChrome(box));
    const send = (msg) => new Promise((r) => box.listener(msg, {}, r));

    const prevFetch = globalThis.fetch;
    let opened = 0, cut = 0;
    globalThis.fetch = (url, opts = {}) =>
      new Promise((res, rej) => {
        if (!/sitemap|\.xml/.test(url)) { res(jsonRes({})); return; }
        opened++;
        const s = opts.signal;
        // как настоящий fetch: уже отменённый сигнал не начинает загрузку
        if (s.aborted) { cut++; rej(new Error("соединение не началось — отмена")); return; }
        s.addEventListener("abort", () => { cut++; rej(new Error("соединение оборвано по отмене")); });
      });

    const pending = send({
      type: "linkify",
      text: "Volvo XC40 поехал на тест-драйв, а Toyota Camry осталась в гараже.",
      requestId: "lk-1",
      overrides: { linkSites: "site.ru" }
    });
    await sleep(50);
    const cancel = await send({ type: "cancelTranslate", requestId: "lk-1" });
    check("отмена застала перелинковку за работой", cancel && cancel.ok === true && cancel.cancelled === true, JSON.stringify(cancel));
    const res = await pending;
    globalThis.fetch = prevFetch;
    check("перелинковка отвечает об отмене, а не о ссылке", res && res.ok === false && res.cancelled === true, JSON.stringify(res));
    check("чужой сайт оборван, а не дочитан", opened > 0 && cut === opened, "открыто: " + opened + ", оборвано: " + cut);
    check("после отмены перебор карт останавливается", opened === 1, "открыто соединений: " + opened);

    // свежий id при этом работает как обычно
    routes.other = () => ({ body: {} });
    const fresh = await send({
      type: "linkify",
      text: "Volvo XC40 поехал.",
      requestId: "lk-2",
      overrides: { linkSites: "" }
    });
    check("перелинковка под новым id доходит до ответа", fresh && fresh.ok === true && !!fresh.stats, JSON.stringify(fresh));
  }

  console.log("\n=== 23. очистка кэша не воскрешает старые переводы ===");
  {
    // Запись кэша — асинхронная, и она может идти в тот момент, когда человек
    // жмёт «Очистить кэш». Без ожидания `set` ложится поверх `remove`, и
    // очищенный кэш возвращается в хранилище целиком.
    await clearCache();
    calls.length = 0;
    routes = {
      google: ({ q }) => ({ body: googleBody(q.toUpperCase()) }),
      mymemory: ({ q }) => ({ body: mmBody(q) })
    };
    slowWriteMs = 120;
    storeOps.length = 0;
    const saving = translateText("Первый абзац.\n\nВторой абзац.", SETTINGS);
    await sleep(40); // запись уже в полёте
    const cleared = clearCache();
    await saving;
    await cleared;
    slowWriteMs = 0;
    // Дожидаемся хвоста: если идущая запись всё-таки ляжет поверх удаления,
    // увидеть это надо здесь, а не после того, как тест уже отчитался.
    await sleep(250);
    check("хранилище чистое", localStore.dzrCache === undefined, JSON.stringify(Object.keys(localStore)));
    check(
      "удаление было последним шагом",
      storeOps[storeOps.length - 1] === "remove",
      "порядок операций: " + storeOps.join(", ")
    );

    // И обычный путь тоже работает: почистили — следующий прогон идёт в сеть.
    calls.length = 0;
    const res = await translateText("Первый абзац.\n\nВторой абзац.", SETTINGS);
    check("после очистки кэш пуст", res.stats.cached === 0 && calls.length > 0, JSON.stringify(res.stats));
  }

  console.log("\n=== 24. чужой странице API-ключ не отдаётся ===");
  {
    // Ключ живёт в local и подставляется в воркере. Панель стоит на чужой
    // странице (и во всех её iframe), и отдавать ей ключ — значит положить
    // секрет в DOM-мир, где его может прочитать скрипт площадки.
    const KEY = "sk-секретный-ключ";
    const OWN_ID = EXT_ID;
    const box = {};
    new Function("chrome", src)(mockWorkerChrome(box, { aiKey: KEY, glossary: "Subaru = Субару" }));
    const listener = box.listener;
    if (!listener) throw new Error("обработчик сообщений не подписан");
    const send = (msg, sender) => new Promise((r) => listener(msg, sender || {}, r));

    const popup = await send({ type: "getSettings" }, { id: OWN_ID, url: "chrome-extension://" + OWN_ID + "/popup.html" });
    check(
      "своему попапу ключ показан — его туда и сохраняют",
      popup && popup.ok === true && popup.settings.aiKey === KEY,
      JSON.stringify(popup && popup.settings && popup.settings.aiKey)
    );

    // Контент-скрипт всегда приходит с tab: он живёт во вкладке. Сверка по
    // одному лишь виду адреса пропускала бы любому контексту, похожему на
    // страницу расширения, поэтому опора — id отправителя (его подставить
    // нельзя) плюс адрес внутри наших собственных ресурсов.
    const panel = await send({ type: "getSettings" }, { id: OWN_ID, url: "https://dzen.ru/i/a1b2c3", tab: { id: 5 } });
    check(
      "панели на чужой странице ключ не уходит",
      panel && panel.ok === true && panel.settings.aiKey === undefined,
      "пришло: " + JSON.stringify(Object.keys((panel && panel.settings) || {}))
    );
    check(
      "обычные настройки панель получает",
      !!((panel && panel.settings) || {}).targetLang,
      JSON.stringify((panel && panel.settings) || {}).slice(0, 120)
    );

    // iframe чужой площадки на той же странице — тот же отказ: all_frames
    // ставит контент-скрипт внутрь чужого документа.
    const frame = await send({ type: "getSettings" }, { id: OWN_ID, url: "https://dzen.ru/i/a1b2c3", tab: { id: 5 }, frameId: 7 });
    check("фрейму на чужой странице ключ тоже не отдаётся", frame && frame.settings && frame.settings.aiKey === undefined, JSON.stringify((frame && frame.settings) || {}).slice(0, 80));

    // Страница другого расширения выглядит как «chrome-extension://…» — и по
    // одному только виду адреса мы отдавали бы ей ключ. Права писать к нам у
    // чужого расширения нет (мы не объявляем externally_connectable), но
    // опознавать своего следует по id, а не по маске адреса.
    const alien = await send({ type: "getSettings" }, { id: "otherextension", url: "chrome-extension://otherextension/popup.html" });
    check("расширению с чужим id ключ не отдаётся", alien && alien.settings && alien.settings.aiKey === undefined, JSON.stringify((alien && alien.settings) || {}).slice(0, 80));
    check("обычные настройки чужому расширению приходят", !!((alien && alien.settings) || {}).targetLang, "");

    // Пустой url — это не «свой»: у сообщения от подставного контекста адрес
    // может отсутствовать, а ключ по умолчанию отдаваться не обязан.
    const noUrl = await send({ type: "getSettings" }, {});
    check("контексту без адреса и без id ключ не отдаётся", noUrl && noUrl.settings && noUrl.settings.aiKey === undefined, JSON.stringify((noUrl && noUrl.settings) || {}).slice(0, 80));

    // Страницу настроек человек открывает во вкладке, и Chrome может подписать
    // такое сообщение номером вкладки. Секрет при этом остаётся на нашей же
    // странице, поэтому признаком «своего» вкладка быть не обязана: опора —
    // id и адрес внутри нашего же расширения.
    const options = await send({ type: "getSettings" }, { id: OWN_ID, url: "chrome-extension://" + OWN_ID + "/options.html", tab: { id: 9 } });
    check("своей странице во вкладке ключ показан", options && options.settings && options.settings.aiKey === KEY, JSON.stringify((options && options.settings) || {}).slice(0, 80));
  }

  console.log("\n=== 25. панель не подставляет фон язык из значений по умолчанию ===");
  {
    // Фон схлопывает `{...getSettings(), ...msg.overrides}`, и каждое поле в
    // overrides — приказ, а не пожелание. Когда настройки не прочитались, в S
    // лежат дефолты, и отправленный «ru» молча подменял бы язык, который
    // человек сохранял в попапе. Поэтому overrides собирает одна функция, и
    // обязана смотреть на признак прочитанности. Поведение это ловится только
    // при загнанном контексте расширения — здесь сторожим конструкцию, чтобы
    // ручная рассылка дефолтов не вернулась незамеченной.
    const csrc = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "content.js"), "utf8");
    const start = csrc.indexOf("function panelOverrides(");
    check("передачу настроек собирает одна функция", start !== -1, "function panelOverrides не найдена");
    const fn = start === -1 ? "" : csrc.slice(start, csrc.indexOf("\n  }", start));
    check("язык цели идёт только из прочитанных настроек или из выбора человека", /settingsReady \|\| langTouched/.test(fn), JSON.stringify(fn.slice(0, 200)));
    check("язык источника идёт только из прочитанных настроек", /if \(settingsReady\)\s*o\.sourceLang/.test(fn), JSON.stringify(fn.slice(0, 200)));
    check("забор языка не вписан руками в сообщение", !/overrides:\s*\{\s*targetLang/.test(csrc), "в translate остался ручной overrides с targetLang");
    check("переводу передаётся собранный объект", /overrides:\s*panelOverrides\(\)/.test(csrc), "");
  }

  console.log("\n=== 26. из текста ошибки вычищено то, что похоже на ключ ===");
  {
    // Тело 4xx и не-JSON ответы попадают в текст ошибки, а тот показывается
    // тостом прямо на странице Дзена и остаётся в логах. Свой адрес API или
    // прокси может ответить эхом присланного ключа — поэтому зачистка стоит
    // внутри shortBody/headOf, а не на месте вызова. Здесь же сторожим, что
    // вычёркивание не съедает объяснение причины: «HTTP 400» без слова человек
    // разобрать не сможет.
    const prevFetch = globalThis.fetch;
    let err = null;
    globalThis.fetch = async () => ({
      ok: false, status: 400, headers: { get: () => null },
      text: async () => '{"error":{"message":"invalid api_key: sk-ABCDEFGHIJKLMNOP1234","type":"invalid_request_error"}}',
      json: async () => ({})
    });
    try {
      await fetchJson("https://api.example.com/v1/chat/completions", { label: "AI", tries: 1, timeout: 500, errorBody: true });
    } catch (e) {
      err = e;
    }
    check("причина отказа осталась в тексте", !!err && /invalid/.test(err.message) && /invalid_request_error/.test(err.message), err && err.message.slice(0, 120));
    check("ключ из тела 4xx не ушёл в ошибку", !!err && !/sk-ABCDEFGHIJKLMNOP1234/.test(err.message) && !/sk-[A-Za-z0-9]{6}/.test(err.message), err && err.message.slice(0, 120));
    check("на месте ключа — явная метка зачистки", !!err && /\[ключ скрыт\]/.test(err.message), err && err.message.slice(0, 120));

    let err2 = null;
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => "<html>auth loop: Bearer sk-ZZZZZZZZZZZZZZZZZZZZ</html>",
      json: async () => { throw new SyntaxError('Unexpected token "<"'); }
    });
    try {
      await fetchJson("https://api.example.com/v1/chat/completions", { label: "AI", tries: 1, timeout: 500 });
    } catch (e) {
      err2 = e;
    }
    globalThis.fetch = prevFetch;
    check("ключ из не-JSON ответа тоже вычищен", !!err2 && !/ZZZZ/.test(err2.message) && /\[ключ скрыт\]/.test(err2.message), err2 && err2.message.slice(0, 120));
    check("начало ответа при этом показано", !!err2 && /auth loop/.test(err2.message), err2 && err2.message.slice(0, 120));

    // Ключ бывает без «sk-» и без подписи api_key: свой прокси повторяет
    // присланный токен как есть. Шаблоны такое не ловят — значение надо
    // вычёркивать по факту отправки, из заголовков запроса.
    let err3 = null;
    globalThis.fetch = async () => ({
      ok: false, status: 400, headers: { get: () => null },
      text: async () => '{"error":"unknown token plain-Secret-Abc12345","type":"auth_error"}',
      json: async () => ({})
    });
    try {
      await fetchJson("https://api.example.com/v1/chat/completions", {
        label: "AI", tries: 1, timeout: 500, errorBody: true,
        headers: { Authorization: "Bearer plain-Secret-Abc12345" }
      });
    } catch (e) {
      err3 = e;
    }
    check("ключ без шаблона вычищен из тела 4xx",
      !!err3 && !/plain-Secret-Abc12345/.test(err3.message), err3 && err3.message.slice(0, 160));
    check("объяснение причины при этом осталось",
      !!err3 && /unknown token/.test(err3.message) && /auth_error/.test(err3.message), err3 && err3.message.slice(0, 160));

    let err4 = null;
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => "<html>proxy echoed plain-Secret-Abc12345</html>",
      json: async () => { throw new SyntaxError('Unexpected token "<"'); }
    });
    try {
      await fetchJson("https://api.example.com/v1/chat/completions", {
        label: "AI", tries: 1, timeout: 500,
        headers: { Authorization: "Bearer plain-Secret-Abc12345" }
      });
    } catch (e) {
      err4 = e;
    }
    globalThis.fetch = prevFetch;
    check("ключ без шаблона вычищен из не-JSON ответа",
      !!err4 && !/plain-Secret-Abc12345/.test(err4.message), err4 && err4.message.slice(0, 160));
  }

  console.log("\n=== 27. тело ответа API читается с потолком ===");
  {
    // Свой aiBaseUrl — такой же чужой сервер, как и сайт карты: он вправе
    // ответить 200 на десятки мегабайт, и res.text() заглотил бы их в воркер.
    // У ответа рерайта потолок обязан быть тем же классом защиты, что у карты.
    const prevFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async () => {
      n++;
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => "x".repeat(API_MAX_BYTES + 10),
        json: async () => ({})
      };
    };
    let err = null;
    try {
      await fetchJson("https://api.example.com/v1/chat/completions", { label: "AI", tries: 3, timeout: 5000 });
    } catch (e) {
      err = e;
    }
    check("гигантский ответ API отклонён с указанием потолка", !!err && /МБ/.test(err.message), err && err.message.slice(0, 120));
    // Повторять такой запрос бессмысленно: адрес пришлёт того же гиганта, а
    // это платный вызов и минуты ожидания впустую.
    check("гигантский ответ API не повторяется", n === 1, "запросов к API сделано: " + n);

    // Объяснение причины 4xx берётся из начала тела. Ради 300 знаков никто не
    // обязан читать весь ответ: поток обрывают и откачивают на месте.
    let textFull = 0;
    let chunks = 0;
    let cancelled = false;
    globalThis.fetch = async () => ({
      ok: false, status: 400, headers: { get: () => null },
      text: async () => { textFull++; return "y".repeat(64 * 1024); },
      json: async () => ({}),
      body: {
        getReader: () => ({
          read: async () => {
            if (chunks >= 8) return { done: true, value: null };
            chunks++;
            const one = new Uint8Array(64 * 1024);
            one.set(new TextEncoder().encode('{"error":"rate limit exceeded"}'));
            return { done: false, value: one };
          },
          cancel: async () => { cancelled = true; }
        })
      }
    });
    let err2 = null;
    try {
      await fetchJson("https://api.example.com/v1/chat/completions", { label: "AI", tries: 1, timeout: 5000, errorBody: true });
    } catch (e) {
      err2 = e;
    }
    globalThis.fetch = prevFetch;
    check("ради объяснения тело целиком не глотают", textFull === 0, "res.text() вызван " + textFull + " раз(а)");
    check("из потока взято только начало", chunks === 1, "кусков прочитано: " + chunks);
    check("остаток потока 4xx откачан", cancelled === true, "cancel не вызван");
    check("начало тела попало в объяснение", !!err2 && /HTTP 400/.test(err2.message) && /rate limit exceeded/.test(err2.message), err2 && err2.message.slice(0, 140));
    check("потолок ответа API задан", typeof API_MAX_BYTES === "number" && API_MAX_BYTES > 1024 * 1024, "API_MAX_BYTES = " + JSON.stringify(API_MAX_BYTES));
  }

  console.log("\n=== 28. проверка обновлений распакованной установки ===");
  {
    // Зачем эта проверка вообще существует: Chrome запрещает распакованному
    // расширению перезаписать свои файлы, поэтому «обновить» изнутри нельзя.
    // Честный ответ — «в main на GitHub версия новее, пересобери пакет вот этой
    // командой и нажми ⟳». Проверяем то, что проще всего соврать: чем сравниваются
    // номера, что именно запрашивается по сети и что человек видит, когда GitHub не
    // ответил.
    const prevFetch = globalThis.fetch;
    const prevVersion = manifestVersion;
    let requested = [];
    let mode = "newer";
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      if (mode === "network") throw new TypeError("Failed to fetch");
      if (mode === "html") {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => "<html>rate limit</html>", json: async () => ({}) };
      }
      if (mode === "missing") return plainRes(404, {});
      if (mode === "noversion") return jsonRes({ manifest_version: 3, name: "Дзен Рерайтер" });
      const version = mode === "same" ? manifestVersion : mode === "older" ? "1.9.9" : "9.9.9";
      return jsonRes({ manifest_version: 3, name: "Дзен Рерайтер", version });
    };

    try {
      // ---- сравнение номеров ----
      check("сравнение версий реализовано", typeof compareVersions === "function");
      check("младшая версия опознана младшей", compareVersions("2.1.9", "2.2.0") === -1, String(compareVersions("2.1.9", "2.2.0")));
      // Строковое сравнение здесь как раз и врёт: «2.10» меньше «2.9», и
      // расширение вечно стояло бы в «обновлений нет» на десятом миноре.
      check("минор сравнивается числом, а не строкой", compareVersions("2.9.0", "2.10.0") === -1, String(compareVersions("2.9.0", "2.10.0")));
      check("одинаковые версии равны", compareVersions("2.1.1", "2.1.1") === 0, String(compareVersions("2.1.1", "2.1.1")));
      check("пропущенный разряд — это ноль", compareVersions("2.1", "2.1.0") === 0, String(compareVersions("2.1", "2.1.0")));
      check("негодная версия не сравнивается", compareVersions("две", "2.1.1") === null && compareVersions("", "2.1.1") === null);

      // ---- три состояния ----
      manifestVersion = "2.1.1";
      mode = "newer";
      requested = [];
      let up = await checkUpdate();
      check("обновление названо обоими номерами", up.state === "update" && up.current === "2.1.1" && up.remote === "9.9.9", JSON.stringify(up));
      check("запрошен манифест main этого репозитория", requested.length === 1 && /raw\.githubusercontent\.com/.test(requested[0]) && /\/main\/src\/extension-src\/manifest\.json$/.test(requested[0]), requested[0]);
      check("команда пересборки выдана", typeof up.command === "string" && up.command.includes("build-extension.cjs"), up.command);
      check("адрес берётся из константы, а не сочинён на ходу", UPDATE_MANIFEST_URL === requested[0], JSON.stringify({ const_: UPDATE_MANIFEST_URL, asked: requested[0] }));
      check("команда берётся из константы", UPDATE_BUILD_COMMAND === up.command, JSON.stringify({ const_: UPDATE_BUILD_COMMAND, given: up.command }));

      mode = "same";
      up = await checkUpdate();
      check("равные версии — обновлений нет", up.state === "latest" && up.remote === "2.1.1", JSON.stringify(up));

      // Собранное из рабочей копии часто новее, чем GitHub уже показывает:
      // человек пересобрал пакет сразу после коммита. Сказать ему «доступно
      // обновление 1.9.9» — значит предложить откатиться назад.
      mode = "older";
      up = await checkUpdate();
      check("установленная новее — обновление не предлагается", up.state === "ahead", JSON.stringify(up));

      // ---- когда ответа нет, враньё запрещено ----
      // «Обновлений нет» — самый худший из возможных ответов при сбое: человек
      // решит, что проверил, и будет пользоваться старым пакетом. Поэтому любой
      // сбой обязан быть ошибкой, а не состоянием latest.
      const fails = [
        ["network", /не дошёл|доступ|сеть|не удал/],
        ["missing", /HTTP 404/],
        ["html", /не JSON/],
        ["noversion", /верси/]
      ];
      for (const [m, expected] of fails) {
        mode = m;
        let err = null;
        try {
          await checkUpdate();
        } catch (e) {
          err = e;
        }
        check("сбой «" + m + "» назван причиной", !!err && expected.test(err.message), err ? err.message.slice(0, 140) : "checkUpdate не сообщил об ошибке");
      }

      // ---- ответ фона на сообщение попапа ----
      const box = {};
      new Function("chrome", src)(mockWorkerChrome(box));
      const sendUpdate = (msg) => new Promise((r) => box.listener(msg, {}, r));

      mode = "newer";
      const okRes = await sendUpdate({ type: "checkUpdate" });
      check("фон отвечает на checkUpdate состоянием", !!okRes && okRes.ok === true && okRes.state === "update" && typeof okRes.command === "string", JSON.stringify(okRes).slice(0, 200));

      mode = "network";
      const badRes = await sendUpdate({ type: "checkUpdate" });
      check("сбой GitHub помечен как ошибка", !!badRes && badRes.ok === false && !!badRes.error, JSON.stringify(badRes).slice(0, 200));
    } catch (e) {
      check("проверка обновлений реализована", false, String((e && e.message) || e));
    } finally {
      globalThis.fetch = prevFetch;
      manifestVersion = prevVersion;
    }
  }

  console.log("\n=== 29. состав и план обновления файлов ===");
  {
    // Зачем этот раздел: обновление пишет в папку установки ровно то, что посчитало
    // update.js. Ошибка в составе — это «расширение перестало загружаться», и ловить
    // её пришлось бы в браузере, где нет ни статуса, ни журнала. Поэтому состав,
    // фильтр путей и порядок запис проверяются здесь, до всякого диалога выбора папки.
    const updPath = path.join(PATHS.REPO, "src", "extension-src", "update.js");
    let upd = null;
    let updErr = "";
    try {
      // update.js — классический скрипт, а не модуль: грузим его как тело функции,
      // тем же приёмом, чем в этом файле грузится background.js. Иначе юнит
      // проверял бы не ту копию кода, которая попадёт в пакет.
      upd = new Function(fs.readFileSync(updPath, "utf8") + "\nreturn DzenUpdate;")();
    } catch (e) {
      updErr = String((e && e.message) || e);
    }
    check(
      "update.js отдаёт модуль с тремя функциями",
      !!upd && typeof upd.updateFileSet === "function" &&
        typeof upd.isSafeRelPath === "function" && typeof upd.planUpdate === "function",
      updErr
    );

    if (upd) {
      // ---- фильтр путей ----
      // Путь уходит в getFileHandle внутри выбранной папки. Ведущий слэш, «..» и
      // обратный слэш — способ уйти за её пределы, поэтому принимаются только
      // относительные пути с прямыми слэшами и без адреса в конце.
      const goodPaths = ["popup.js", "content.css", "icons/icon48.png", "a/b/c.js"];
      const badPaths = ["/x", "..", "a/../../b", "C:\\x", "a?b", "a#b", "icons\\icon48.png", "\\\\server\\x", "https://cdn/x.js", "", null, 7];
      goodPaths.forEach((p) => check("путь «" + p + "» принят", upd.isSafeRelPath(p) === true, String(upd.isSafeRelPath(p))));
      badPaths.forEach((p) => check("путь «" + String(p) + "» отвергнут", upd.isSafeRelPath(p) === false, String(upd.isSafeRelPath(p))));

      // ---- состав файлов ----
      // Состав выводится из манифеста и из HTML-страниц, а не из зашитого списка:
      // иначе обновление не смогло бы принести новый файл.
      const manifest = JSON.parse(fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "manifest.json"), "utf8"));
      const popupHtml = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "popup.html"), "utf8");
      let imagesHtml = "";
      try {
        imagesHtml = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "images.html"), "utf8");
      } catch (e) {}
      const set = upd.updateFileSet(manifest, { "popup.html": popupHtml, "images.html": imagesHtml });
      check("состав отсортирован", JSON.stringify(set) === JSON.stringify(set.slice().sort()), set.join(", "));
      check("в составе нет дублей", new Set(set).size === set.length, set.join(", "));
      const mustHave = [
        "manifest.json", "background.js", "content.js", "rewriter.js", "presets.js",
        "content.css", "popup.html", "popup.js", "images.html", "images.js", "images-page.js",
        "icons/icon16.png", "icons/icon48.png", "icons/icon128.png"
      ];
      const missing = mustHave.filter((p) => set.indexOf(p) < 0);
      check("состав называет все файлы пакета", missing.length === 0, missing.join(", "));
      // popup.js и images-page.js в манифеста нет — они видны только из страниц
      // вторым уровнем. options_ui указывает на images.html, action.default_popup —
      // на popup.html, поэтому текст окна подбора обязателен для состава.
      check("сторона наружу в состав не попала", set.every((p) => upd.isSafeRelPath(p)), set.filter((p) => !upd.isSafeRelPath(p)).join(", "));

      // Сверка с собранной папкой: неверный состав либо не донесёт нужный файл,
      // либо принесёт README, которого в манифесте нет. Лишнее — так же плохо, как
      // недостающее: expansion-пакет с чужим файлом Chrome не примет.
      const onDisk = [];
      (function walk(dir, rel) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
          const r = rel ? rel + "/" + ent.name : ent.name;
          if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
          else onDisk.push(r);
        });
      })(PATHS.EXT, "");
      const wantList = onDisk.filter((p) => p !== "README.md").sort();
      check(
        "состав равен собранной папке без README",
        JSON.stringify(set.slice().sort()) === JSON.stringify(wantList),
        JSON.stringify({ посчитано: set.slice().sort(), наДиске: wantList })
      );

      // ---- журнал и его ключ ----
      check(
        "имя манифеста и ключ журнала зафиксированы в модуле",
        upd.MANIFEST_NAME === "manifest.json" && upd.INTENT_KEY === "dzrUpdateIntent",
        JSON.stringify({ manifest: upd.MANIFEST_NAME, intent: upd.INTENT_KEY })
      );

      // ---- план записи ----
      const bytes = (s) => new TextEncoder().encode(s);
      const fileSet = ["a.js", "b.css", "manifest.json"];
      const local = { "a.js": bytes("одинаково"), "b.css": bytes("старое"), "manifest.json": bytes("2.2.0") };
      const remote = { "a.js": bytes("одинаково"), "b.css": bytes("новое"), "manifest.json": bytes("2.3.0") };
      const plan = upd.planUpdate(fileSet, local, remote);
      // Совпавший файл не пишется: повтор клика обязан дописывать ровно то, что
      // не дописалось, а не перемалывать байты, уже лежащие на диске.
      check("совпавший файл в план не попал", plan.indexOf("a.js") < 0, plan.join(", "));
      check("изменённые названы оба", JSON.stringify(plan.slice().sort()) === JSON.stringify(["b.css", "manifest.json"]), plan.join(", "));
      check("manifest.json пишется последним", plan[plan.length - 1] === "manifest.json", plan.join(", "));
      check("без отличий план пуст", upd.planUpdate(fileSet, local, local).length === 0, JSON.stringify(upd.planUpdate(fileSet, local, local)));
      // Файла нет локально — он новый, и «пусто» здесь не значит «совпало».
      const planNew = upd.planUpdate(["new.js", "manifest.json"], { "manifest.json": bytes("2.2.0") }, { "new.js": bytes("тело"), "manifest.json": bytes("2.3.0") });
      check("отсутствующий локально файл пишется", planNew.indexOf("new.js") >= 0 && planNew[planNew.length - 1] === "manifest.json", planNew.join(", "));
      // Разница в один байт в конце тела — это тоже разница: сверка по длине
      // пропустила бы обрезанный файл.
      check("сверка идёт побайтно, а не по длине",
        upd.planUpdate(["x.js"], { "x.js": bytes("12345") }, { "x.js": bytes("12346") }).length === 1);
    }
  }

  console.log("\n=== 30. пакет обновления собирается в фоне ===");
  {
    // Зачем этот раздел: до первой записи на диск все байты должны быть скачаны,
    // а состав — взят из далёкого манифеста, а не из списка в коде. Ошибка здесь
    // двух сортов: недосохранившийся пакет (расширение не загружается) и лишняя
    // запись чужого пути. Оба ловятся до всякого диалога выбора папки.
    const updSrc = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "update.js"), "utf8");
    const base = "https://raw.githubusercontent.com/zanzibara82/dzen-up/main/src/extension-src/";
    const enc = (s) => new TextEncoder().encode(s);
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const REMOTE_MANIFEST = {
      manifest_version: 3,
      name: "Дзен Рерайтер — перевод и рерайт статей",
      version: "9.9.9",
      background: { service_worker: "background.js" },
      content_scripts: [{ js: ["presets.js", "content.js"], css: ["content.css"] }],
      action: { default_popup: "popup.html", default_icon: { "16": "icons/icon16.png" } },
      icons: { "16": "icons/icon16.png" }
    };
    // popup.js в манифеста нет — он обязан прийти вторым уровнем из popup.html.
    let remoteFiles = {
      "manifest.json": enc(JSON.stringify(REMOTE_MANIFEST)),
      "background.js": enc("background девятого релиза"),
      "presets.js": enc("presets девятого релиза"),
      "content.js": enc("content девятого релиза"),
      "content.css": enc("body{color:red}"),
      "popup.html": enc('<html><script src="popup.js"></script></html>'),
      "popup.js": enc("popup девятого релиза"),
      "icons/icon16.png": PNG
    };
    let urls = [];
    let failWith = null; // {rel, res} — что отдать вместо файла
    const prevFetch = globalThis.fetch;
    const prevVersion = manifestVersion;
    manifestVersion = "2.2.0";
    globalThis.fetch = async (url) => {
      const full = String(url);
      const rel = full.slice(base.length).split("?")[0];
      urls.push(full);
      if (failWith && failWith.rel === rel) return failWith.res;
      const bytes = remoteFiles[rel];
      if (!bytes) return { ok: false, status: 404, headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-length" ? String(bytes.byteLength) : null) },
        body: null,
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.slice().buffer
      };
    };

    // importScripts воркеру не нужен: update.js конкатенацией, а его отсутствие в
    // харнессе видно по `typeof importScripts === "function"` в самом фоне.
    const bgApi = new Function(
      "chrome",
      updSrc + "\n" + src +
      "\nreturn { remoteBase: typeof remoteBase === \"function\" ? remoteBase : null, " +
      " buildUpdatePackage: typeof buildUpdatePackage === \"function\" ? buildUpdatePackage : null, " +
      " UPDATE_MANIFEST_URL: typeof UPDATE_MANIFEST_URL === \"string\" ? UPDATE_MANIFEST_URL : null, " +
      " API_MAX_BYTES: typeof API_MAX_BYTES === \"number\" ? API_MAX_BYTES : null };"
    )(chrome);

    try {
      check("фон умеет собирать пакет", !!bgApi.buildUpdatePackage && !!bgApi.remoteBase);
      check(
        "префикс адреса — каталог манифеста",
        !!bgApi.remoteBase && bgApi.remoteBase() === base,
        bgApi.remoteBase && bgApi.remoteBase()
      );

      const pkg = await bgApi.buildUpdatePackage();
      const pathsGotten = pkg.files.map((f) => f.path);
      check(
        "состав пакета взят из далёкого манифеста",
        JSON.stringify(pathsGotten) === JSON.stringify(["background.js", "content.css", "content.js", "icons/icon16.png", "manifest.json", "popup.html", "popup.js", "presets.js"]),
        pathsGotten.join(", ")
      );
      check("версии названы обе", pkg.current === "2.2.0" && pkg.remote === "9.9.9", JSON.stringify({ current: pkg.current, remote: pkg.remote }));
      // Один файл — один запрос. Проверка нужна ровно из-за manifest.json: его же
      // читают, чтобы узнать состав, и простая реализация скачала бы его дважды.
      check("каждый файл запрошен один раз", urls.length === pathsGotten.length && new Set(urls.map((u) => u.split("?")[0])).size === urls.length, urls.length + " запросов: " + urls.map((u) => u.slice(base.length)).join(", "));
      check("каждый запрос — под обходятелем кэша", urls.every((u) => /[?&]dzr=\d+/.test(u)), urls[0]);
      check("запросы идут только по каталогу пакета", urls.every((u) => u.indexOf(base) === 0), urls.find((u) => u.indexOf(base) !== 0));

      const icon = pkg.files.filter((f) => f.path === "icons/icon16.png")[0];
      // png текстом не переносим: decode→encode по utf-8 необратим, и иконка
      // вернулась бы битой. Проверка байтов, а не длины, ловит ровно это.
      check(
        "иконка пришла байт в байт",
        !!icon && icon.bytes instanceof Uint8Array && icon.bytes.length === PNG.length && Array.from(icon.bytes).join() === Array.from(PNG).join(),
        icon ? Array.from(icon.bytes).slice(0, 8).join() : "иконы в пакете нет"
      );
      const manifestFile = pkg.files.filter((f) => f.path === "manifest.json")[0];
      check(
        "манифест пакета — те же байты, что прочитаны",
        !!manifestFile && new TextDecoder().decode(manifestFile.bytes) === JSON.stringify(REMOTE_MANIFEST),
        manifestFile ? new TextDecoder().decode(manifestFile.bytes).slice(0, 60) : "манифеста в пакете нет"
      );

      // ---- сбой на любом файле: не пишем ничего ----
      const fails = [
        ["404 на content.js", { rel: "content.js", res: { ok: false, status: 404, headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) } }, /content\.js/],
        ["пустое тело у popup.js", { rel: "popup.js", res: { ok: true, status: 200, headers: { get: () => "0" }, body: null, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) } }, /popup\.js/],
        ["файл за потолком", { rel: "background.js", res: { ok: true, status: 200, headers: { get: (k) => (String(k).toLowerCase() === "content-length" ? String((bgApi.API_MAX_BYTES || 0) + 1) : null) }, body: null, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) } }, /размер|потолок|больше/]
      ];
      for (const [title, fault, expected] of fails) {
        failWith = fault;
        urls = [];
        let err = null;
        try {
          await bgApi.buildUpdatePackage();
        } catch (e) {
          err = e;
        }
        check(title + " — пакет не собран", !!err && expected.test(err.message), err ? err.message.slice(0, 160) : "ошибки нет");
      }
      failWith = null;

      // Далёкий манифест, который не разобрать, — не «обновлений нет»: человек
      // ушёл бы на старом пакете, решив, что проверил.
      const savedManifest = remoteFiles["manifest.json"];
      remoteFiles["manifest.json"] = enc("<html>rate limit</html>");
      let err = null;
      try {
        await bgApi.buildUpdatePackage();
      } catch (e) {
        err = e;
      }
      check("не-JSON манифеста назван причиной", !!err && /не JSON|разобр/ig.test(err.message), err ? err.message.slice(0, 160) : "ошибки нет");
      remoteFiles["manifest.json"] = savedManifest;

      // ---- ответ фона на сообщение попапа ----
      const box = {};
      new Function("chrome", updSrc + "\n" + src)(mockWorkerChrome(box));
      const askPackage = (msg) => new Promise((r) => box.listener(msg, {}, r));
      urls = [];
      const okRes = await askPackage({ type: "updatePackage" });
      check(
        "фон отвечает на updatePackage пакетом",
        !!okRes && okRes.ok === true && okRes.remote === "9.9.9" && Array.isArray(okRes.files) && okRes.files.length === 8 && okRes.files[0].bytes instanceof Uint8Array,
        okRes ? JSON.stringify({ ok: okRes.ok, remote: okRes.remote, файлов: (okRes.files || []).length }) : "ответа нет"
      );
      failWith = fails[0][1];
      const badRes = await askPackage({ type: "updatePackage" });
      check("сбой помечен ошибкой, а не пустым пакетом", !!badRes && badRes.ok === false && !!badRes.error, JSON.stringify(badRes).slice(0, 180));
      failWith = null;
    } catch (e) {
      check("сборка пакета реализована", false, String((e && e.message) || e));
    } finally {
      globalThis.fetch = prevFetch;
      manifestVersion = prevVersion;
    }
  }

  console.log("\n=== 31. выбранная папка проверяется до первой записи ===");
  {
    // Зачем этот раздел: человек мог выбрать любую папку — свою сборку другого
    // расширения, пустой каталог или то, что уже перенесли. Ни один из этих
    // случаев нельзя «обновить»: файлы легли бы туда, где их никто не читает, а
    // статус сказал бы «обновлено». Поэтому проверка папки — чистая функция, и
    // причины у неё канонические: их показывает и попап, и тест.
    const { makeFakeRoot } = require("./fixtures/fake-dir-handle.cjs");
    let upd2 = null;
    let err2 = "";
    try {
      const updSrc = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "update.js"), "utf8");
      upd2 = new Function(updSrc + "\nreturn DzenUpdate;")();
    } catch (e) {
      err2 = String((e && e.message) || e);
    }
    check(
      "модуль умеет читать файлы папки и судить о ней",
      !!upd2 && typeof upd2.readRel === "function" && typeof upd2.installDirProblem === "function",
      err2
    );

    try {
      if (upd2) {
      const NAME = "Дзен Рерайтер — перевод и рерайт статей";
      const good = { "manifest.json": JSON.stringify({ manifest_version: 3, name: NAME, version: "2.2.0" }), "popup.html": "<html></html>" };
      const dir = (files, opts) => upd2.installDirProblem(makeFakeRoot(files, opts), NAME);

      check("годная папка не даёт причины", (await dir(good)) === null, JSON.stringify(await dir(good)));
      check("папка без манифеста — «не читается»", (await dir({ "popup.html": "<html></html>" })) === "не читается", await dir({ "popup.html": "<html></html>" }));
      check("манифест не разбирается — «не читается»", (await dir({ "manifest.json": "<html>не json</html>" })) === "не читается", await dir({ "manifest.json": "<html>не json</html>" }));
      check("пустой манифест — «не читается»", (await dir({ "manifest.json": "" })) === "не читается", await dir({ "manifest.json": "" }));
      check("вторая версия манифеста — не наша папка", (await dir({ "manifest.json": JSON.stringify({ manifest_version: 2, name: NAME }) })) === "не манифест третьей версии", await dir({ "manifest.json": JSON.stringify({ manifest_version: 2, name: NAME }) }));
      // Чужое расширение в соседней папке — самый опасный промах: файлы его пакета
      // были бы перезаписаны нашим кодом, и оно перестало бы загружаться.
      check("папка другого расширения опознана", (await dir({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Иное расширение" }) })) === "не то расширение", await dir({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Иное расширение" }) }));
      check("папку удалили или перенесли — названо это", (await dir(good, { failOn: "read", failRel: "manifest.json" })) === "папки на месте нет", await dir(good, { failOn: "read", failRel: "manifest.json" }));

      // readRel — единственная дверь к байтам на диске: план сверяется по ней.
      const root = makeFakeRoot(good);
      const bytes = await upd2.readRel(root, "manifest.json");
      check("readRel отдаёт массив байтов", bytes instanceof Uint8Array && new TextDecoder().decode(bytes) === good["manifest.json"], bytes && bytes.constructor.name);
      check("readRel читает через getFileHandle", root.__calls.indexOf("file:manifest.json") >= 0 && root.__calls.indexOf("read:manifest.json") >= 0, root.__calls.join(", "));
      check("отсутствующего файла нет — и это не пустой файл", (await upd2.readRel(root, "nope.js")) === null, String(await upd2.readRel(root, "nope.js")));
      check("чтение по поддомену работает", new TextDecoder().decode(await upd2.readRel(makeFakeRoot({ "icons/icon16.png": "пиксели" }), "icons/icon16.png")) === "пиксели");

      // Имя базы и ключ зафиксированы: рукоять, сохранённая одной версией,
      // обязана найтись в другой, иначе «обновить» каждый раз звала бы диалог.
      check(
        "хранилище рукояти и папка отката названы константами",
        typeof upd2.IDB_NAME === "string" && !!upd2.IDB_NAME && typeof upd2.IDB_STORE === "string" && !!upd2.IDB_STORE &&
          typeof upd2.IDB_KEY === "string" && !!upd2.IDB_KEY && upd2.BACKUP_DIR === ".dzr-backup",
          JSON.stringify({ db: upd2.IDB_NAME, store: upd2.IDB_STORE, key: upd2.IDB_KEY, backup: upd2.BACKUP_DIR })
        );
      }
    } catch (e) {
      // Падение харнесса вместо провала проверки спрятало бы весь раздел:
      // ИТОГ этого набора не печатается, и «провалов: 0» значит «не дошли».
      check("проверка папки не роняет набор", false, String((e && e.message) || e));
    }
  }

  console.log("\n=== 32. запись пакета на диск: резерв, порядок и откат ===");
  {
    // Запись — единственное место, где обновление трогает файлы человека. До
    // первой записи всё скачано и проверено, но диск может отказать посередине:
    // тогда уже записанное обязано вернуться к старым байтам, а новый файл —
    // исчезнуть, иначе установка осталась бы в полусостоянии без выхода.
    const { makeFakeRoot } = require("./fixtures/fake-dir-handle.cjs");
    const updSrc = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "update.js"), "utf8");
    const upd = new Function(updSrc + "\nreturn DzenUpdate;")();
    const enc = (s) => new TextEncoder().encode(s);
    const dec = (b) => (b ? new TextDecoder().decode(b) : null);

    check(
      "модуль умеет писать, удалять и читать карту файлов",
      typeof upd.writeRel === "function" && typeof upd.removeRel === "function" &&
        typeof upd.readLocalMap === "function" && typeof upd.backupPlan === "function" &&
        typeof upd.applyPlan === "function",
      Object.keys(upd).join(", ")
    );

    try {
      // ---- writeRel ----
      const root = makeFakeRoot({ "manifest.json": "2.2.0" });
      await upd.writeRel(root, "popup.js", enc("тело попапа"));
      check("writeRel кладёт байты на диск", root.__text("popup.js") === "тело попапа", root.__text("popup.js"));
      check("writeRel идёт через createWritable", root.__calls.indexOf("open:popup.js") >= 0 && root.__calls.indexOf("write:popup.js") >= 0 && root.__calls.indexOf("close:popup.js") >= 0, root.__calls.join(", "));
      await upd.writeRel(root, "icons/icon48.png", enc("пиксели"));
      check("writeRel создаёт подпапку под файл", root.__text("icons/icon48.png") === "пиксели", root.__text("icons/icon48.png"));
      await upd.writeRel(root, "popup.js", enc("новое тело"));
      check("writeRel перезаписывает существующий файл", root.__text("popup.js") === "новое тело", root.__text("popup.js"));

      // ---- removeRel ----
      await upd.removeRel(root, "popup.js");
      check("removeRel убирает файл с диска", root.__text("popup.js") === null, String(root.__text("popup.js")));
      let removedAbsent = true;
      try { await upd.removeRel(root, "нет-такого.js"); } catch (e) { removedAbsent = false; }
      check("removeRel отсутствующего файла не бросает", removedAbsent, String(removedAbsent));

      // ---- readLocalMap ----
      const mapRoot = makeFakeRoot({ "a.js": "байты а", "icons/i.png": "иконка" });
      const localMap = await upd.readLocalMap(mapRoot, ["a.js", "icons/i.png", "new.js"]);
      check("readLocalMap отдаёт байты присутствующих", dec(localMap["a.js"]) === "байты а" && dec(localMap["icons/i.png"]) === "иконка", JSON.stringify(Object.keys(localMap)));
      check("readLocalMap отсутствующий помечает null", localMap["new.js"] === null, String(localMap["new.js"]));

      // ---- backupPlan ----
      const bRoot = makeFakeRoot({ "a.js": "старое а", "manifest.json": "2.2.0" });
      const bLocal = { "a.js": enc("старое а"), "new.js": null, "manifest.json": enc("2.2.0") };
      await upd.backupPlan(bRoot, "2.2.0", ["a.js", "new.js", "manifest.json"], bLocal);
      check("резерв копирует старые байты в .dzr-backup/<from>/", bRoot.__text(".dzr-backup/2.2.0/a.js") === "старое а" && bRoot.__text(".dzr-backup/2.2.0/manifest.json") === "2.2.0", JSON.stringify(Object.keys(bRoot.__files)));
      check("новый файл в резерв не попадает — его нечего возвращать", bRoot.__text(".dzr-backup/2.2.0/new.js") === null, String(bRoot.__text(".dzr-backup/2.2.0/new.js")));
      check("резерв не трогает сами файлы", bRoot.__text("a.js") === "старое а", bRoot.__text("a.js"));

      // ---- applyPlan: порядок и байты ----
      const aRoot = makeFakeRoot({ "a.js": "старое а", "b.css": "старое б", "manifest.json": "2.2.0" });
      const aLocal = { "a.js": enc("старое а"), "b.css": enc("старое б"), "manifest.json": enc("2.2.0") };
      const aRemote = { "a.js": enc("новое а"), "b.css": enc("новое б"), "manifest.json": enc("2.3.0") };
      const written = await upd.applyPlan(aRoot, ["b.css", "a.js", "manifest.json"], aRemote, aLocal);
      check("applyPlan возвращает записанные файлы", JSON.stringify(written) === JSON.stringify(["b.css", "a.js", "manifest.json"]), JSON.stringify(written));
      check("applyPlan кладёт новые байты", aRoot.__text("a.js") === "новое а" && aRoot.__text("b.css") === "новое б" && aRoot.__text("manifest.json") === "2.3.0", JSON.stringify({ a: aRoot.__text("a.js"), m: aRoot.__text("manifest.json") }));
      const closes = aRoot.__calls.filter((c) => c.indexOf("close:") === 0);
      check("манифест закрывается последним", closes[closes.length - 1] === "close:manifest.json", closes.join(", "));

      // ---- applyPlan: откат уже записанного при отказе диска ----
      const rRoot = makeFakeRoot({ "a.js": "старое а", "b.js": "старое б", "manifest.json": "2.2.0" }, { failOn: "write", failRel: "b.js" });
      const rLocal = { "a.js": enc("старое а"), "b.js": enc("старое б"), "manifest.json": enc("2.2.0") };
      const rRemote = { "a.js": enc("новое а"), "b.js": enc("новое б"), "manifest.json": enc("2.3.0") };
      let rolledBack = false;
      try { await upd.applyPlan(rRoot, ["a.js", "b.js", "manifest.json"], rRemote, rLocal); }
      catch (e) { rolledBack = true; }
      check("отказ диска посередине бросает наружу", rolledBack, String(rolledBack));
      check("откат вернул уже записанный файл к старым байтам", rRoot.__text("a.js") === "старое а", rRoot.__text("a.js"));
      check("манифест при откате не тронут — версия прежняя", rRoot.__text("manifest.json") === "2.2.0", rRoot.__text("manifest.json"));

      // ---- applyPlan: новый файл при откате удаляется, а не остаётся сиротой ----
      const nRoot = makeFakeRoot({ "manifest.json": "2.2.0" }, { failOn: "write", failRel: "manifest.json" });
      const nLocal = { "new.js": null, "manifest.json": enc("2.2.0") };
      const nRemote = { "new.js": enc("тело нового"), "manifest.json": enc("2.3.0") };
      let newRolled = false;
      try { await upd.applyPlan(nRoot, ["new.js", "manifest.json"], nRemote, nLocal); }
      catch (e) { newRolled = true; }
      check("откат после создания нового файла бросает", newRolled, String(newRolled));
      check("новый файл при откате удалён с диска", nRoot.__text("new.js") === null, String(nRoot.__text("new.js")));
      check("манифест остался прежним при откате нового файла", nRoot.__text("manifest.json") === "2.2.0", nRoot.__text("manifest.json"));

      // ---- restoreFromBackup: «Вернуть <версию>» из резерва на диске ----
      // Резерв переживает убийство браузера, поэтому возврат читает именно диск,
      // а не память. Восстанавливаются все файлы резерва, манифест в их числе.
      const restRoot = makeFakeRoot({
        "manifest.json": "2.3.0",
        "popup.js": "новый попап",
        ".dzr-backup/2.2.0/manifest.json": "2.2.0",
        ".dzr-backup/2.2.0/popup.js": "старый попап"
      });
      const restored = await upd.restoreFromBackup(restRoot, "2.2.0");
      check("restoreFromBackup возвращает список восстановленных файлов",
        JSON.stringify(restored.slice().sort()) === JSON.stringify(["manifest.json", "popup.js"]), JSON.stringify(restored));
      check("возврат кладёт старые байты из резерва",
        restRoot.__text("manifest.json") === "2.2.0" && restRoot.__text("popup.js") === "старый попап",
        JSON.stringify({ m: restRoot.__text("manifest.json"), p: restRoot.__text("popup.js") }));
      const emptyRestore = await upd.restoreFromBackup(makeFakeRoot({ "manifest.json": "2.2.0" }), "9.9.9");
      check("без резерва возврат не трогает файлы и не бросает",
        emptyRestore.length === 0, JSON.stringify(emptyRestore));
    } catch (e) {
      check("запись пакета не роняет набор", false, String((e && e.message) || e));
    }
  }

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
      execFileSync(process.execPath, [path.join(PATHS.REPO, "tools", "build-extension.cjs"), "--out", out, "--no-zip", "--force"], { stdio: "pipe" });
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

  console.log("\n=== 36. сборщик: строгие аргументы и защита чужой папки ===");
  {
    // Опечатка в имени аргумента раньше молча оставляла путь по умолчанию —
    // живую папку установки, — и сборщик сносил её. Непонятный аргумент обязан
    // остановить сборку до первого удаления.
    const os = require("os");
    const { spawnSync } = require("child_process");
    const BUILDER = path.join(PATHS.REPO, "tools", "build-extension.cjs");
    const run = (args) => spawnSync(process.execPath, [BUILDER, ...args], { encoding: "utf8" });
    let root = "";
    try {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "bld-args-"));

      const eq = path.join(root, "dzen-rewriter");
      const eqRes = run(["--out=" + eq, "--no-zip"]);
      check("форма --out=… понимается",
        eqRes.status === 0 && fs.existsSync(path.join(eq, "manifest.json")),
        String(eqRes.status) + " " + String(eqRes.stderr).slice(0, 120));

      const typo = run(["--outt", path.join(root, "dzen-rewriter-typo"), "--no-zip"]);
      check("опечатка в аргументе останавливает сборку", typo.status !== 0, String(typo.status));
      check("опечатка названа в stderr", /--outt/.test(String(typo.stderr)), String(typo.stderr).slice(0, 160));

      const noVal = run(["--out"]);
      check("--out без значения останавливает сборку", noVal.status !== 0, String(noVal.status));

      const backup = path.join(root, "dzen-rewriter-backup");
      fs.mkdirSync(backup);
      fs.writeFileSync(path.join(backup, "живое.txt"), "не трогать");
      const bd = run(["--out", backup, "--no-zip"]);
      check("папка не с именем установки без --force не тронута",
        bd.status !== 0 && fs.existsSync(path.join(backup, "живое.txt")), String(bd.status));
      const bf = run(["--out", backup, "--no-zip", "--force"]);
      check("--force разрешает перезапись",
        bf.status === 0 && fs.existsSync(path.join(backup, "manifest.json")) && !fs.existsSync(path.join(backup, "живое.txt")),
        String(bf.status));

      const exact = path.join(root, "exact", "dzen-rewriter");
      fs.mkdirSync(exact, { recursive: true });
      fs.writeFileSync(path.join(exact, "старый.txt"), "мусор");
      const ex = run(["--out", exact, "--no-zip"]);
      check("папка с точным именем пересобирается без --force",
        ex.status === 0 && !fs.existsSync(path.join(exact, "старый.txt")), String(ex.status));

      // Манифест ссылается на файл, которого нет в списке сборки: пакет
      // получился бы незагружаемым. Сборщик обязан сказать это до сноса папки.
      const copyRoot = path.join(root, "copy");
      fs.cpSync(path.join(PATHS.REPO, "src"), path.join(copyRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(copyRoot, "tools"), { recursive: true });
      fs.copyFileSync(BUILDER, path.join(copyRoot, "tools", "build-extension.cjs"));
      const manPath = path.join(copyRoot, "src", "extension-src", "manifest.json");
      const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
      man.background.service_worker = "background2.js";
      fs.writeFileSync(manPath, JSON.stringify(man, null, 2));
      const badMan = spawnSync(
        process.execPath,
        [path.join(copyRoot, "tools", "build-extension.cjs"), "--out", path.join(root, "dzen-rewriter-copy"), "--no-zip"],
        { encoding: "utf8" }
      );
      check("манифест со ссылкой на файл вне сборки останавливает сборку", badMan.status !== 0, String(badMan.status));
      check("пропавший файл назван", /background2\.js/.test(String(badMan.stderr)), String(badMan.stderr).slice(0, 160));
    } catch (e) {
      check("строгие аргументы сборщика не роняют набор", false, String((e && e.message) || e));
    } finally {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("\n=== 37. забор текста: «Отменить» не ждёт executeScript ===");
  {
    // chrome.scripting.executeScript не смотрит ни на отмену, ни на таймаут.
    // Без своего потолка «Отменить» ждала бы, пока чужой скрипт доработает на
    // странице, — а человек уже нажал кнопку.
    const box = {};
    const knob = mockWorkerChrome(box);
    knob.scripting.executeScript = () => new Promise(() => {}); // страница «зависла»
    new Function("chrome", src)(knob);
    const listener = box.listener;
    if (!listener) throw new Error("обработчик сообщений не подписан");
    const send = (msg, sender) => new Promise((r) => listener(msg, sender || {}, r));

    const pending = send({ type: "fetchSource", url: "https://example.com/article", requestId: "src-1" }, { tab: { id: 9 } });
    await sleep(5);
    if (box.tabUpdated) box.tabUpdated(1, { status: "complete" }); // страница догрузилась
    await sleep(5);
    await send({ type: "cancelTranslate", requestId: "src-1" }, { tab: { id: 9 } });
    const res = await Promise.race([pending, sleep(1000).then(() => null)]);
    check("отмена забора не ждёт executeScript", !!res && res.ok === false && res.cancelled === true, JSON.stringify(res));
  }

  console.log("\n=== 38. закрытая вкладка отменяет прогон ===");
  {
    // Панель исчезла вместе с вкладкой, а платный вызов модели продолжался:
    // ответ уходил в несуществующий порт, и человек платил за оборванный прогон.
    const box = {};
    new Function("chrome", src)(mockWorkerChrome(box));
    const listener = box.listener;
    if (!listener) throw new Error("обработчик сообщений не подписан");
    check("слушатель закрытия вкладок подписан", typeof box.tabRemoved === "function", typeof box.tabRemoved);

    const prevFetch = globalThis.fetch;
    globalThis.fetch = (url, opts = {}) =>
      new Promise((resolve, reject) => {
        const onAbort = () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        };
        if (opts.signal) {
          if (opts.signal.aborted) onAbort();
          else opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    try {
      const send = (msg, sender) => new Promise((r) => listener(msg, sender || {}, r));
      const pending = send(
        {
          type: "aiRewrite",
          text: "привет мир.",
          requestId: "tab-1",
          overrides: { aiKey: "sk-test", aiModel: "m", aiPrompt: "перепиши" }
        },
        { tab: { id: 7 } }
      );
      await sleep(20); // запрос к модели уже ушёл
      if (box.tabRemoved) box.tabRemoved(7);
      const res = await Promise.race([pending, sleep(1000).then(() => null)]);
      check("закрытие вкладки отменяет вызов модели", !!res && res.ok === false && res.cancelled === true, JSON.stringify(res));
    } finally {
      globalThis.fetch = prevFetch;
    }
  }

  console.log("\n=== 39. кэш карт: потолок записей, квота и очистка ===");
  {
    // dzrSitemaps и dzrChannels росли без предела: каждая прочитанная карта
    // остаётся в storage.local навсегда. Упёршись в квоту, запись падала и
    // глоталась, а «Очистить кэш» эти ключи не трогал — кэш терялся молча.
    const qStore = {};
    const QUOTA = 9000;
    const qChrome = Object.assign({}, chrome, {
      storage: {
        ...chrome.storage,
        local: {
          get: async (key) =>
            qStore[key] === undefined ? {} : { [key]: JSON.parse(JSON.stringify(qStore[key])) },
          set: async (obj) => {
            const text = JSON.stringify(obj);
            if (text.length > QUOTA) throw new Error("QUOTA_BYTES quota exceeded");
            for (const [k, v] of Object.entries(obj)) qStore[k] = JSON.parse(JSON.stringify(v));
          },
          remove: async (key) => {
            delete qStore[key];
          }
        }
      }
    });
    const cacheApi = new Function(
      "chrome",
      src +
        "\nreturn { mergeLocalCache, SITEMAP_CACHE_KEY, " +
        ' LOCAL_CACHE_MAX_ENTRIES: typeof LOCAL_CACHE_MAX_ENTRIES === "number" ? LOCAL_CACHE_MAX_ENTRIES : null };'
    )(qChrome);
    const KEY = "dzrSitemaps";

    const seeded = {};
    for (let i = 0; i < 12; i++) seeded["old" + i + ".ru"] = { at: i, urls: ["https://old" + i + ".ru/"] };
    qStore[KEY] = seeded;
    await cacheApi.mergeLocalCache(KEY, "new.ru", { at: 100, urls: [] });
    const kept = qStore[KEY] || {};
    const limit = cacheApi.LOCAL_CACHE_MAX_ENTRIES;
    check("потолок записей кэша карт задан", typeof limit === "number" && limit > 0, "потолок: " + limit);
    check(
      "кэш не растёт сверх потолка",
      !!limit && Object.keys(kept).length <= limit,
      "записей: " + Object.keys(kept).length
    );
    check("свежая запись на месте", !!kept["new.ru"], Object.keys(kept).join(" "));
    check("самая старая запись вытеснена", !kept["old0.ru"], Object.keys(kept).join(" "));

    // Квота: запись падает — ужимаемся и пробуем снова. Новая карта не должна
    // пропадать только потому, что старые ещё лежат в хранилище.
    for (const k of Object.keys(qStore)) delete qStore[k];
    const blob = "x".repeat(2500);
    const fat = {};
    for (let i = 0; i < 6; i++) fat["fat" + i + ".ru"] = { at: i, urls: [blob] };
    qStore[KEY] = fat;
    await cacheApi.mergeLocalCache(KEY, "fresh.ru", { at: 100, urls: ["https://fresh.ru/"] });
    const after = qStore[KEY] || {};
    check("после квоты запись повторена, а не потеряна", !!after["fresh.ru"], Object.keys(after).join(" "));
    check(
      "после квоты запись ужата под потолок хранилища",
      JSON.stringify({ [KEY]: after }).length <= QUOTA,
      "длина: " + JSON.stringify({ [KEY]: after }).length
    );
    check("ужатие вытеснило старые карты", Object.keys(after).length < 6, "записей: " + Object.keys(after).length);

    // «Очистить кэш» обязан убирать и карты — иначе они не удаляются никогда.
    localStore.dzrSitemaps = { "a.ru": { at: 1, urls: [] } };
    localStore.dzrChannels = { ch: { at: 1, articles: [] } };
    localStore.dzrCache = { k: { at: 1, t: "x" } };
    await clearCache();
    check("очистка кэша убирает карты сайтов", localStore.dzrSitemaps === undefined);
    check("очистка кэша убирает карты каналов", localStore.dzrChannels === undefined);
  }

  console.log("\n=== ИТОГ ===");
  const bad = results.filter((r) => !r.ok);
  console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
  bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e); process.exit(1); });
