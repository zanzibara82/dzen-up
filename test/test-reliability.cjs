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
const chrome = {
  storage: {
    sync: { get: async (d) => ({ ...d }), set: async () => {} },
    local: {
      get: async (d) => ({ ...d, ...localStore }),
      set: async (o) => Object.assign(localStore, o),
      remove: async (k) => { delete localStore[k]; }
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
  src + "\nreturn { translateText, splitChunks, fetchJson, mapPool, clearCache, hashStr, looksLikeTargetLang, DEFAULTS };"
)(chrome);
const { translateText, splitChunks, fetchJson, mapPool, clearCache, looksLikeTargetLang, DEFAULTS } = api;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    json: async () => body
  };
}
function plainRes(status, headers) {
  return {
    ok: false, status, headers: { get: (k) => headers[k.toLowerCase()] || null },
    json: async () => ({})
  };
}
function googleBody(text) {
  return [text.split(/(?<=[.!?…])\s+/).filter(Boolean).map((s) => [s, s, null, null])];
}
function mmBody(text) {
  return { responseStatus: 200, responseData: { translatedText: text } };
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
    const res = await translateText("Кусок текста.", SETTINGS);
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

  console.log("\n=== ИТОГ ===");
  const bad = results.filter((r) => !r.ok);
  console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
  bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e); process.exit(1); });
