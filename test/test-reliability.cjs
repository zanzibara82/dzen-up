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
  runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
  contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  tabs: { sendMessage: async () => {}, query: async () => [] }
};

const src = fs.readFileSync(SRC, "utf8");
const api = new Function(
  "chrome",
  src +
    "\nreturn { translateText, splitChunks, fetchJson, mapPool, clearCache, hashStr, " +
    "looksLikeTargetLang, myMemoryTranslate, DEFAULTS };"
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
  DEFAULTS
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
    runtime: { onMessage: { addListener: (fn) => { box.listener = fn; } }, onInstalled: { addListener() {} } },
    contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      sendMessage: async () => {},
      query: async () => [],
      create: async () => ({ id: 1 }),
      remove: async () => {},
      onUpdated: { addListener() {}, removeListener() {} },
      update: async () => {}
    },
    permissions: { contains: async () => true, request: async () => true },
    scripting: { executeScript: async () => [{ result: null }] },
    action: { badgeText: { set: async () => {} } }
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
    const res = await translateText("ЖИВОЙ кусок.\n\nМёртвый кусок.", SETTINGS);
    check("stats.failed = 1", res.stats.failed === 1, JSON.stringify(res.stats));
    check("непереведённый кусок оставлен как есть", res.text.includes("Мёртвый кусок."), JSON.stringify(res.text));
    check("остальное переведено", res.text.includes("ЖИВОЙ КУСОК."), JSON.stringify(res.text));
    check("не бросил исключение", true);
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
    const box = {};
    new Function("chrome", src)(mockWorkerChrome(box, { aiKey: KEY, glossary: "Subaru = Субару" }));
    const listener = box.listener;
    if (!listener) throw new Error("обработчик сообщений не подписан");
    const send = (msg, sender) => new Promise((r) => listener(msg, sender || {}, r));

    const popup = await send({ type: "getSettings" }, { url: "chrome-extension://abc/popup.html" });
    check(
      "своему попапу ключ показан — его туда и сохраняют",
      popup && popup.ok === true && popup.settings.aiKey === KEY,
      JSON.stringify(popup && popup.settings && popup.settings.aiKey)
    );

    const panel = await send({ type: "getSettings" }, { url: "https://dzen.ru/i/a1b2c3" });
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
    const frame = await send({ type: "getSettings" }, { url: "https://dzen.ru/i/a1b2c3", frameId: 7 });
    check("фрейму на чужой странице ключ тоже не отдаётся", frame && frame.settings && frame.settings.aiKey === undefined, JSON.stringify((frame && frame.settings) || {}).slice(0, 80));
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
  }

  console.log("\n=== ИТОГ ===");
  const bad = results.filter((r) => !r.ok);
  console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
  bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e); process.exit(1); });
