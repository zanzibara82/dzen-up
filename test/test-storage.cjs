/**
 * Тест раскладки настроек по хранилищам.
 *
 * Что проверяем и почему:
 *  1. Глоссарий больше 8 КБ обязан сохраняться и читаться целиком.
 *     Раньше он лежал в chrome.storage.sync, где лимит QUOTA_BYTES_PER_ITEM =
 *     8192 байта НА КЛЮЧ, и такой set() падал — настройка молча терялась.
 *     Первая проверка нарочно воспроизводит старый сценарий: пишем глоссарий
 *     прямо в sync и убеждаемся, что квота действительно срабатывает. Иначе
 *     тест «зелёный», а баг не воспроизведён и нечего чинить.
 *  2. Глоссарий и API-ключ лежат в local, остальные настройки — в sync.
 *  3. Старые значения из sync переносятся в local и из sync удаляются.
 *  4. Слишком большой текст промпта даёт понятную ошибку, а не тихий успех,
 *     и глоссарий при этом уже сохранён (local пишется первым).
 *  5. Попап показывает эту ошибку пользователю и не врёт про «Сохранено».
 */
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const ROOT = PATHS.REPO;
const TMP = PATHS.SCRATCH;
const TEST_EXT = path.join(TMP, "test-ext-storage");
const USER_DATA = PATHS.testProfile("storage");
const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const CHROME = PATHS.CHROME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  let buf = "", id = 0;
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
        toBrowser.write(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }) + "\0");
        setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); } }, 20000);
      })
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}

// Глоссарий заметно больше лимита 8 КБ — считаем в символах, чтобы не зависеть
// от того, как Chrome меряет байты (UTF-8 против UTF-16).
function makeBigGlossary(target) {
  const lines = [];
  let n = 0;
  for (let i = 0; lines.join("\n").length < target; i++) {
    lines.push(`Brand Name ${i} = Бренд ${i}`);
    n++;
    if (n > 5000) break;
  }
  return lines.join("\n");
}

async function main() {
  copyDir(SRC_EXT, TEST_EXT);

  const BIG = makeBigGlossary(14000);
  console.log("глоссарий: %d символов, %d строк", BIG.length, BIG.split("\n").length);

  const chrome = spawn(CHROME, [
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    "--user-data-dir=" + USER_DATA, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--window-size=520,760", "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

  const c = pipeCdp(chrome);
  try {
    let extId = null;
    for (let i = 0; i < 40; i++) {
      try { const r = await c.send("Extensions.loadUnpacked", { path: TEST_EXT }); extId = r.id; break; }
      catch (e) { if (i === 39) throw e; await sleep(400); }
    }
    await PATHS.clearStorage(c, extId, TEST_EXT);
    console.log("расширение: %s", extId);

    const { targetId } = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
    await c.send("Runtime.enable", {}, sessionId);
    const evalJs = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
      return r.result.value;
    };

    for (let i = 0; i < 40; i++) {
      if (await evalJs(`!!document.getElementById('save')`)) break;
      await sleep(200);
    }

    // помощник для сообщений service worker'у
    await evalJs(`window.__send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r || { ok: false, error: String(((chrome.runtime.lastError || {}).message) || "нет ответа") }))); true`);
    await evalJs(`window.__big = ${JSON.stringify(BIG)}; true`);

    // ------------------------------------------------ 0. баг был настоящим ---
    // Пишем большой глоссарий прямо в sync — так делал старый saveSettings.
    const directSync = await evalJs(`new Promise((resolve) => {
      chrome.storage.sync.set({ glossary: window.__big }, () => {
        resolve({ err: ((chrome.runtime.lastError || {}).message) || null });
      });
    })`);
    console.log("прямая запись в sync: %j", directSync);
    check(
      "старый путь действительно ломается: большой глоссарий в sync не влезает",
      !!directSync.err && /quota/i.test(directSync.err),
      directSync.err || "ошибки нет — тест не воспроизводит баг"
    );
    // подчистим следы неудачной записи
    await evalJs(`new Promise((r) => chrome.storage.sync.remove(['glossary', 'aiKey'], r))`);

    // ------------------------------------------ 1. большой глоссарий едет ---
    const saved = await evalJs(`__send({ type: 'saveSettings', settings: { glossary: window.__big } })`);
    console.log("saveSettings: %j", saved);
    check("большой глоссарий сохраняется без ошибки", saved.ok === true, JSON.stringify(saved.error || ""));

    const round = await evalJs(`(async () => {
      const res = await __send({ type: 'getSettings' });
      const local = await chrome.storage.local.get(['glossary', 'aiKey']);
      const sync = await chrome.storage.sync.get(['glossary', 'aiKey']);
      return {
        ok: res.ok,
        len: ((res.settings || {}).glossary || '').length,
        same: ((res.settings || {}).glossary || '') === window.__big,
        localLen: (local.glossary || '').length,
        syncGlossary: sync.glossary === undefined ? null : sync.glossary.length,
        syncKeys: Object.keys(sync)
      };
    })()`);
    console.log("круговой рейс: %j", round);
    check("глоссарий читается из настроек целиком", round.ok === true && round.len === BIG.length, "получено " + round.len + " из " + BIG.length);
    check("глоссарий совпадает посимвольно", round.same === true);
    check("глоссарий лежит в local", round.localLen === BIG.length, "в local " + round.localLen);
    check("в sync глоссария нет", round.syncGlossary === null && round.syncKeys.length === 0, JSON.stringify(round.syncKeys));

    // ---------------------------------- 2. остальные настройки — в sync ---
    const split = await evalJs(`(async () => {
      const res = await __send({ type: 'saveSettings', settings: {
        targetLang: 'en', mode: 'rewrite', engine: 'mymemory', preview: false,
        aiKey: 'sk-test-' + 'x'.repeat(300), aiEnabled: true
      }});
      const local = await chrome.storage.local.get(['glossary', 'aiKey']);
      const sync = await chrome.storage.sync.get(['targetLang', 'mode', 'engine', 'preview', 'aiEnabled', 'glossary', 'aiKey']);
      const got = await __send({ type: 'getSettings' });
      return {
        ok: res.ok,
        saved: res.saved,
        localKey: (local.aiKey || '').length,
        syncHasKey: sync.aiKey !== undefined,
        syncHasGlossary: sync.glossary !== undefined,
        sync: { targetLang: sync.targetLang, mode: sync.mode, engine: sync.engine, preview: sync.preview, aiEnabled: sync.aiEnabled },
        back: { targetLang: got.settings.targetLang, mode: got.settings.mode, engine: got.settings.engine, preview: got.settings.preview, keyLen: (got.settings.aiKey || '').length }
      };
    })()`);
    console.log("раскладка: %j", split);
    check("сохранение сообщает, что куда легло", split.ok === true && Array.isArray(split.saved && split.saved.local) && Array.isArray(split.saved && split.saved.sync), JSON.stringify(split.saved));
    check("в local попал только API-ключ", JSON.stringify((split.saved || {}).local) === JSON.stringify(["aiKey"]), JSON.stringify((split.saved || {}).local));
    check("в sync ушли мелкие настройки", JSON.stringify((split.saved || {}).sync) === JSON.stringify(["targetLang", "mode", "engine", "preview", "aiEnabled"]), JSON.stringify((split.saved || {}).sync));
    check("API-ключ ушёл в local", split.localKey === 308, "длина ключа в local: " + split.localKey);
    check("в sync ключа нет", split.syncHasKey === false);
    check("в sync глоссария по-прежнему нет", split.syncHasGlossary === false);
    check("мелкие настройки ушли в sync", split.sync.targetLang === "en" && split.sync.mode === "rewrite" && split.sync.engine === "mymemory" && split.sync.preview === false && split.sync.aiEnabled === true, JSON.stringify(split.sync));
    check("настройки читаются обратно правильно", split.back.targetLang === "en" && split.back.mode === "rewrite" && split.back.engine === "mymemory" && split.back.preview === false && split.back.keyLen === 308, JSON.stringify(split.back));

    // -------------------------------------- 3. перенос старых значений ---
    const migrated = await evalJs(`(async () => {
      // имитируем расширение «прошлой версии»: значения лежат в sync, в local их нет
      await chrome.storage.local.remove(['glossary', 'aiKey']);
      await chrome.storage.sync.set({ glossary: 'Subaru = Субару\\nBoxer = оппозитный', aiKey: 'sk-legacy-key' });
      const before = await chrome.storage.sync.get(['glossary', 'aiKey']);
      const res = await __send({ type: 'getSettings' });
      const local = await chrome.storage.local.get(['glossary', 'aiKey']);
      const after = await chrome.storage.sync.get(['glossary', 'aiKey']);
      return {
        beforeSync: Object.keys(before).length,
        ok: res.ok,
        glossary: (res.settings || {}).glossary,
        key: (res.settings || {}).aiKey,
        localGlossary: local.glossary === undefined ? null : local.glossary,
        localKey: local.aiKey === undefined ? null : local.aiKey,
        afterSyncKeys: Object.keys(after)
      };
    })()`);
    console.log("перенос: %j", migrated);
    check("старый глоссарий перенесён в local", migrated.localGlossary === "Subaru = Субару\nBoxer = оппозитный", JSON.stringify(migrated.localGlossary));
    check("старый ключ перенесён в local", migrated.localKey === "sk-legacy-key", JSON.stringify(migrated.localKey));
    check("из sync старые значения удалены", migrated.afterSyncKeys.length === 0, JSON.stringify(migrated.afterSyncKeys));
    check("перенесённые значения видны в настройках", migrated.glossary === "Subaru = Субару\nBoxer = оппозитный" && migrated.key === "sk-legacy-key");

    // --- 3b. пустое значение в local не должно съедать перенос ----------------
    // Именно здесь ломался перенос: seedDefaults писал в local пустую строку,
    // она считалась «значение уже есть» — и глоссарий из sync удалялся, так и не
    // переехав. Для пользователя это выглядело бы как пропавший глоссарий.
    const emptyLocal = await evalJs(`(async () => {
      await chrome.storage.local.set({ glossary: '', aiKey: '' });
      await chrome.storage.sync.set({ glossary: 'Legacy Term = Наследие' });
      const res = await __send({ type: 'getSettings' });
      const local = await chrome.storage.local.get(['glossary']);
      const sync = await chrome.storage.sync.get(['glossary']);
      return {
        local: local.glossary === undefined ? null : local.glossary,
        syncKeys: Object.keys(sync),
        settings: (res.settings || {}).glossary
      };
    })()`);
    console.log("пустой local: %j", emptyLocal);
    check("пустое значение в local не мешает переносу из sync", emptyLocal.local === "Legacy Term = Наследие", JSON.stringify(emptyLocal));
    check("глоссарий не потерян при переносе", emptyLocal.settings === "Legacy Term = Наследие" && emptyLocal.syncKeys.length === 0, JSON.stringify(emptyLocal));

    // ------------------------------- 4. переполнение sync: понятная ошибка ---
    const quota = await evalJs(`(async () => {
      const huge = 'П'.repeat(20000);
      // Кладём короткий промпт сами. На чистом профиле в sync его ещё нет, и
      // «гигантский не попал» проходило бы даром: пустое место — тоже не гигант.
      // Проверять надо именно то, что прежнее значение не затёрто.
      await chrome.storage.sync.set({ aiPrompt: 'короткий промпт' });
      const res = await __send({ type: 'saveSettings', settings: { aiPrompt: huge, glossary: window.__big } });
      const local = await chrome.storage.local.get(['glossary']);
      const sync = await chrome.storage.sync.get(['aiPrompt']);
      return {
        ok: res.ok,
        error: res.error || '',
        localGlossary: (local.glossary || '').length,
        syncPrompt: sync.aiPrompt === undefined ? null : sync.aiPrompt.length,
        syncPromptValue: sync.aiPrompt === undefined ? null : sync.aiPrompt
      };
    })()`);
    console.log("переполнение: %j", quota);
    check("переполнение sync не выглядит как успех", quota.ok === false, JSON.stringify(quota));
    check("в ошибке названо поле и лимит", /aiPrompt/.test(quota.error) && /8 КБ/.test(quota.error), quota.error.slice(0, 140));
    // в sync остаётся прежнее (короткое) значение промпта, а не гигантское
    check("гигантский промпт в sync не попал", quota.syncPromptValue === "короткий промпт", "в sync " + JSON.stringify(String(quota.syncPromptValue).slice(0, 30)) + " (" + quota.syncPrompt + " симв.)");
    check("глоссарий сохранён, несмотря на ошибку sync", quota.localGlossary === BIG.length, "в local " + quota.localGlossary);

    // ------------------------------------------ 5. попап говорит правду ---
    const ui = await evalJs(`(async () => {
      document.getElementById('tab-settings').click();
      document.getElementById('aiPrompt').value = 'П'.repeat(20000);
      document.getElementById('glossary').value = 'Term = Термин';
      document.getElementById('save').click();
      await new Promise((r) => setTimeout(r, 1200));
      const st = document.getElementById('settings-status');
      return { text: st.textContent, cls: st.className };
    })()`);
    console.log("попап: %j", ui);
    check("попап показал ошибку сохранения", /❌/.test(ui.text) && /8 КБ/.test(ui.text), ui.text.slice(0, 160));
    check("ошибка помечена как ошибка", /err/.test(ui.cls), ui.cls);

    const uiOk = await evalJs(`(async () => {
      document.getElementById('aiPrompt').value = 'короткий промпт';
      document.getElementById('glossary').value = window.__big;
      document.getElementById('save').click();
      await new Promise((r) => setTimeout(r, 1200));
      const local = await chrome.storage.local.get(['glossary']);
      return {
        text: document.getElementById('settings-status').textContent,
        localLen: (local.glossary || '').length,
        syncBytes: await new Promise((r) => chrome.storage.sync.getBytesInUse(null, r))
      };
    })()`);
    console.log("попап после исправления: %j", uiOk);
    check("после сокращения промпта сохранение проходит", /Сохранено/.test(uiOk.text), uiOk.text.slice(0, 120));
    check("большой глоссарий дошёл до local через попап", uiOk.localLen === BIG.length, "в local " + uiOk.localLen);
    check("sync остался маленьким (< 8 КБ)", uiOk.syncBytes < 8192, uiOk.syncBytes + " байт");

    // ------------------------------- 6. перезагрузка попапа видит глоссарий ---
    await evalJs(`location.reload()`);
    await sleep(900);
    for (let i = 0; i < 40; i++) {
      if (await evalJs(`!!document.getElementById('glossary')`)) break;
      await sleep(200);
    }
    // после перезагрузки страницы window.__big исчез — возвращаем его для сверки
    await evalJs(`window.__big = ${JSON.stringify(BIG)}; true`);
    const afterReload = await evalJs(`(async () => {
      for (let i = 0; i < 30; i++) {
        const v = document.getElementById('glossary').value;
        if (v) return { len: v.length, same: v === window.__big, prompt: document.getElementById('aiPrompt').value };
        await new Promise((r) => setTimeout(r, 200));
      }
      return { len: 0, same: false, prompt: '' };
    })()`);
    console.log("после перезагрузки: %j", afterReload);
    check("попап подхватил большой глоссарий из хранилища", afterReload.same === true, "длина " + afterReload.len);
    check("промпт остался сокращённым", afterReload.prompt === "короткий промпт", JSON.stringify(afterReload.prompt));

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (errs.length) {
      console.log("\nисключения:");
      errs.slice(-6).forEach((e) => console.log("  ", JSON.stringify(e.params).slice(0, 300)));
    }

    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const p = path.join(TMP, "shot-storage.png");
    fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
    console.log("\nскриншот: %s", p);

    console.log("\n=== ИТОГ ===");
    const bad = results.filter((r) => !r.ok);
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
    bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
  } finally {
    try { execSync("taskkill /F /T /PID " + chrome.pid, { stdio: "ignore" }); } catch {}
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e.message || e); process.exit(1); });
