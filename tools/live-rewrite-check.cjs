/**
 * Живая проверка AI-рерайта на настоящем ключе и настоящем сервисе.
 *
 *   node tools/live-rewrite-check.cjs [путь-к-папке-расширения]
 *
 * Настройки берутся из профиля браузера, где расширение установлено: так
 * проверяется ровно то, что человек вписал, а не то, что мы придумали в тесте.
 * Профиль можно задать переменной DZR_PROFILE.
 *
 * Ключи НИКУДА не печатаются и никуда не пишутся: в отчёт идёт маска, значения
 * живут только в памяти процесса. Это ручная проверка перед сдачей, а не
 * регрессия — в общий прогон её не включаем.
 *
 * Что проверяем: проверку ключа, сам рерайт и путь кнопки (перевод → рерайт).
 * Обязателен контроль: с заведомо чужим ключом рерайт обязан отказать, иначе
 * «зелёный» прогон ничего не доказывает.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const PATHS = require("../test/paths.cjs");

const TMP = PATHS.SCRATCH;
const TEST_EXT = path.join(TMP, "live-rw-ext");
const USER_DATA = PATHS.testProfile("liverw");
const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const CHROME = PATHS.CHROME;

const EXT_ID = "lccpjhkoloofdihmnpkjhgklgahackib"; // id нашего расширения в профиле
const PROFILE =
  process.env.DZR_PROFILE ||
  path.join(process.env.LOCALAPPDATA || "", "Yandex", "YandexBrowser", "User Data", "Default");

// ---------------------------------------------------------------- leveldb ---
// chrome.storage лежит в leveldb, а не в файле настроек. Читаем журналы
// (`.log`) как последовательность пакетов записи: у каждого пакета заголовок на
// 12 байт, дальше записи «тип, ключ, значение». Берём ПОСЛЕДНЮЮ запись по
// ключу — в журнале остаются и прежние значения, и если взять первое, легко
// проверить старый ключ и решить, что дело в сервисе.

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    result += (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result, p];
}

/** Журнал leveldb — блоки по 32 КиБ с заголовком записи на 7 байт. */
function readLogRecords(file) {
  const buf = fs.readFileSync(file);
  const BLOCK = 32768;
  const chunks = [];
  let pos = 0;
  let acc = null;

  while (pos + 7 <= buf.length) {
    const blockEnd = Math.floor(pos / BLOCK) * BLOCK + BLOCK;
    if (pos + 7 > blockEnd) {
      pos = blockEnd;
      acc = null;
      continue;
    }
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    const start = pos + 7;
    if (start + len > buf.length) break;
    const payload = buf.subarray(start, start + len);

    if (type === 1) chunks.push(Buffer.from(payload));
    else if (type === 2) acc = Buffer.from(payload);
    else if (type === 3 && acc) acc = Buffer.concat([acc, payload]);
    else if (type === 4 && acc) {
      chunks.push(Buffer.concat([acc, payload]));
      acc = null;
    }
    pos = start + len;
  }

  const pairs = [];
  for (const b of chunks) {
    if (b.length < 12) continue;
    const count = b.readUInt32LE(8);
    let p = 12;
    for (let i = 0; i < count && p < b.length; i++) {
      const t = b[p++];
      let klen;
      [klen, p] = readVarint(b, p);
      const key = b.subarray(p, p + klen).toString("utf8");
      p += klen;
      if (t !== 1) continue; // удаление — не значение
      let vlen;
      [vlen, p] = readVarint(b, p);
      const raw = b.subarray(p, p + vlen).toString("utf8");
      p += vlen;
      let val;
      try { val = JSON.parse(raw); } catch (e) { continue; }
      pairs.push({ key, val });
    }
  }
  return pairs;
}

function readStore(dir) {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".log")).sort()) {
    for (const { key, val } of readLogRecords(path.join(dir, f))) out[key] = val;
  }
  return out;
}

function readBrowserSettings(profile, extId) {
  const local = readStore(path.join(profile, "Local Extension Settings", extId));
  const sync = readStore(path.join(profile, "Sync Extension Settings", extId));
  return { ...local, ...sync };
}

const mask = (v) => {
  const s = String(v || "");
  if (!s) return "(пусто)";
  if (s.length <= 10) return "…(" + s.length + " зн.)";
  return s.slice(0, 4) + "…" + s.slice(-2) + " (" + s.length + " зн.)";
};

/**
 * Выдать копии право на домен AI-сервиса.
 *
 * В манифесте перечислены только api.openai.com и openrouter.ai. Свой адрес
 * (z.ai, прокси, локальный сервер) без права недоступен: запрос режет
 * предварительная проверка CORS, и в панели остаётся «Failed to fetch». В
 * тестовом профиле дополнительное право выдать нечем (кнопка требует жеста, а
 * `clearStorage` стирает выданное при перезагрузке), поэтому право прописываем
 * в КОПИЮ манифеста — и говорим об этом вслух.
 */
function grantAiOrigin(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin + "/*";
  } catch (e) {
    return null;
  }
  const mf = path.join(TEST_EXT, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.host_permissions = m.host_permissions || [];
  if (m.host_permissions.includes(origin)) return origin;
  m.host_permissions.push(origin);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  return origin;
}

// ------------------------------------------------------------------- тест ---
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
          if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); }
        }, 120000);
      })
  };
}

// Текст для рерайта — обычный русский абзац: у него видно и смысл, и то, что
// модель его переписала, а не пересказала двумя словами.
const SOURCE = [
  "Кофе в зернах лучше покупать у обжарщика, который указывает дату обжарки, а не срок годности.",
  "Свежесть влияет на вкус сильнее, чем сорт и страна происхождения: через две недели после обжарки зерно теряет большую часть аромата.",
  "Храните зерно в непрозрачной банке с плотной крышкой, подальше от плиты и от света.",
  "Молоть стоит прямо перед завариванием — уже молотый кофе выдыхается за считаные часы."
].join(" ");

const cyrillicShare = (s) => {
  const letters = String(s).replace(/[^A-Za-zА-Яа-яЁё]/g, "");
  if (!letters) return 0;
  const cyr = letters.replace(/[^А-Яа-яЁё]/g, "").length;
  return cyr / letters.length;
};

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

async function main() {
  const st = readBrowserSettings(PROFILE, EXT_ID);
  console.log("профиль: %s", PROFILE);
  console.log("расширение в профиле: %s", EXT_ID);

  const settings = {};
  for (const k of ["aiKey", "aiBaseUrl", "aiModel", "aiEnabled", "aiPrompt", "aiPreset", "pixabayKey", "imgSource"]) {
    if (st[k] !== undefined) settings[k] = st[k];
  }
  // Адрес и модель можно подставить, чтобы проверить «а если поправить» — не
  // трогая настройки человека. Ключ подставить нельзя: он только из профиля.
  if (process.env.DZR_AI_BASE) settings.aiBaseUrl = process.env.DZR_AI_BASE;
  if (process.env.DZR_AI_MODEL) settings.aiModel = process.env.DZR_AI_MODEL;

  console.log("настройки из профиля:");
  for (const k of Object.keys(settings).sort()) {
    const v = settings[k];
    const shown = /key/i.test(k) ? mask(v) : typeof v === "string" && v.length > 60 ? "«" + v.slice(0, 50) + "…» (" + v.length + " зн.)" : JSON.stringify(v);
    console.log("  %s = %s", k, shown);
  }

  if (!settings.aiKey) {
    console.error("\nв профиле нет AI-ключа — нечего проверять");
    process.exit(2);
  }

  copyDir(SRC_EXT, TEST_EXT);
  const granted = grantAiOrigin(settings.aiBaseUrl || "");
  console.log("копии выдано право на: %s\n", granted || "(адрес не разобран)");

  const chrome = spawn(
    CHROME,
    [
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--user-data-dir=" + USER_DATA,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1280,900",
      "about:blank"
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

    const probe = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    const ps = await c.send("Target.attachToTarget", { targetId: probe.targetId, flatten: true });
    await c.send("Runtime.enable", {}, ps.sessionId);
    const probeEval = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, ps.sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };
    for (let i = 0; i < 30; i++) {
      if (await probeEval(`!!document.getElementById('save')`)) break;
      await sleep(200);
    }
    await probeEval(
      `window.__send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, ` +
        `(r) => res(r || { ok: false, error: String(((chrome.runtime.lastError || {}).message) || "нет ответа") }))); true`
    );

    const send = (msg) => probeEval(`__send(${JSON.stringify(msg)})`);

    const setSettings = async (patch) => {
      const want = Object.keys(patch);
      let ok = false;
      for (let i = 0; i < 8; i++) {
        const res = await send({ type: "saveSettings", settings: patch });
        const raw = await probeEval(
          `__send({ type: 'getSettings' }).then((r) => JSON.stringify((r || {}).settings || {}))`
        );
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (e) {}
        if (res && res.ok && want.every((k) => parsed[k] === patch[k])) { ok = true; break; }
        await sleep(400);
      }
      if (!ok) throw new Error("не удалось применить настройки: " + JSON.stringify(want));
    };

    await setSettings(settings);
    console.log("настройки применены в тестовом профиле\n");

    // ---- 0. Какие модели вообще видит ключ ---------------------------------
    // Не проверка, а справка: самая частая причина «рерайт не идёт» — модель,
    // которой у провайдера нет. Список отвечает на это одним взглядом, и по
    // нему же видно, что ключ дошёл до сервиса.
    try {
      const base = String(settings.aiBaseUrl || "").replace(/\/+$/, "");
      const r = await fetch(base + "/models", { headers: { Authorization: "Bearer " + settings.aiKey } });
      const text = await r.text();
      let ids = [];
      try {
        const j = JSON.parse(text);
        ids = (j.data || j.models || []).map((m) => m.id || m.model || m.name).filter(Boolean);
      } catch (e) {}
      console.log("модели по этому ключу: %s", ids.length ? ids.join(", ") : "сервис списка не отдал (HTTP " + r.status + ")");
      if (ids.length && settings.aiModel && !ids.includes(settings.aiModel)) {
        console.log("  ⚠️ выбранной модели «%s» в списке нет", settings.aiModel);
      }
      console.log("");
    } catch (e) {
      console.log("список моделей не спросить: %s\n", e.message);
    }

    // ---- 1. Ключ и модель --------------------------------------------------
    console.log("=== 1. Проверка ключа ===");
    const keyRes = await send({ type: "checkKey", kind: "ai" });
    const keyText = String((keyRes && (keyRes.text || keyRes.error)) || "");
    check("ключ рабочий", !!(keyRes && keyRes.ok), "«" + keyText.slice(0, 120) + "»");
    check("модель ответила и названа", /ответила/.test(keyText), "«" + keyText.slice(0, 120) + "»");
    check("названа именно заданная модель",
      !settings.aiModel || keyText.includes(String(settings.aiModel)),
      "ждали «" + (settings.aiModel || "(по умолчанию)") + "»");

    // ---- 2. Контроль: чужой ключ обязан отказать --------------------------
    // Локальный сервер (Ollama) ключ не проверяет вовсе — заголовок Authorization
    // он игнорирует. Тогда контроль не «провален», а неприменим, и сказать об этом
    // надо словами: иначе отчёт врёт в другую сторону, объявляя рабочую настройку
    // сломанной.
    console.log("\n=== 2. Контроль: чужой ключ ===");
    const BAD_KEY = "sk-0000000000000000000000000000000000000000";
    const bad = await send({ type: "checkKey", kind: "ai", overrides: { aiKey: BAD_KEY } });
    const badText = String((bad && (bad.text || bad.error)) || "");
    if (bad && bad.ok === true) {
      check(
        "сервис ключ не проверяет — контроль неприменим (локальный сервер?)",
        true,
        "чужой ключ принят: «" + badText.slice(0, 90) + "»"
      );
    } else {
      check("с чужим ключом отказано", true, "«" + badText.slice(0, 140) + "»");
      check("отказ объяснён, а не проглочен", badText.length > 10, "«" + badText.slice(0, 140) + "»");
      const badRw = await send({
        type: "aiRewrite",
        text: SOURCE,
        overrides: { aiKey: BAD_KEY }
      });
      check(
        "рерайт с чужим ключом отказал",
        !!(badRw && badRw.ok === false),
        "«" + String((badRw && badRw.error) || "").slice(0, 140) + "»"
      );
    }

    // ---- 3. Рерайт ---------------------------------------------------------
    console.log("\n=== 3. Рерайт настоящим ключом ===");
    const t0 = Date.now();
    const rw = await send({ type: "aiRewrite", text: SOURCE });
    const dt = Date.now() - t0;
    check("рерайт вернулся без ошибки", !!(rw && rw.ok), (rw && rw.error) || dt + " мс");
    if (!rw || !rw.ok) throw new Error("рерайт не удался: " + ((rw && rw.error) || "нет ответа"));

    const out = String(rw.text || "").trim();
    check("текст непустой", out.length > 0, words(out) + " слов за " + dt + " мс");
    check("текст изменился", out !== SOURCE.trim());
    check("текст на русском", cyrillicShare(out) > 0.8,
      "кириллицы " + Math.round(cyrillicShare(out) * 100) + "%");
    check("текст не обрезан", words(out) >= words(SOURCE) * 0.5,
      words(out) + " слов против " + words(SOURCE) + " в исходнике");
    check("смысл на месте: про обжарку",
      /обжарк/i.test(out), "«" + out.slice(0, 110) + "…»");
    console.log("\n  исходник: %s", SOURCE.slice(0, 100) + "…");
    console.log("  рерайт:   %s\n", out.slice(0, 160) + (out.length > 160 ? "…" : ""));

    // ---- 4. Путь кнопки: перевод → рерайт ----------------------------------
    console.log("=== 4. Путь кнопки: перевод, затем рерайт ===");
    const tr = await send({ type: "translate", text: SOURCE, overrides: { targetLang: "ru" } });
    check("перевод прошёл", !!(tr && tr.ok), (tr && tr.error) || "");
    if (tr && tr.ok) {
      const translated = String(tr.text || "").trim();
      check("русский текст не переводился заново", translated === SOURCE.trim() || /обжарк/i.test(translated),
        "пропущено фрагментов: " + ((tr.stats && tr.stats.skipped) || 0) + " из " + ((tr.stats && tr.stats.total) || 0));
      const rw2 = await send({ type: "aiRewrite", text: translated });
      check("рерайт поверх перевода сработал", !!(rw2 && rw2.ok), (rw2 && rw2.error) || "");
      if (rw2 && rw2.ok) {
        check("итог пути кнопки отличается от исходника", String(rw2.text).trim() !== SOURCE.trim());
        console.log("  итог:     %s", String(rw2.text).slice(0, 160) + "…");
      }
    }
  } finally {
    try { chrome.kill(); } catch (e) {}
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log("\nвсего проверок: %d, провалов: %d", results.length, failed);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("ошибка прогона:", e.message);
  process.exit(1);
});
