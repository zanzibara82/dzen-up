/**
 * Живая проверка Pixabay: расширение против НАСТОЯЩЕГО сервиса.
 *
 *   PB_KEY=<ключ> node tools/live-pixabay-check.cjs [путь-к-папке-расширения]
 *
 * В общий прогон не входит: требует ключа, ест чужие лимиты и деньги. Это ручная
 * проверка перед сдачей, а не регрессия.
 *
 * Зачем отдельный набор: обычный test-images-ui подменяет адрес Pixabay на
 * мок-сервер — иначе он не тест, а поход в интернет. Здесь наоборот: адрес
 * остаётся настоящим, а проверяем мы то, чего мок дать не может — что живой
 * сервис отвечает, что разбор понимает его поля и что отказ по чужому ключу
 * объясняется словами сервиса, а не голым «HTTP 400».
 *
 * Ключ приходит переменной окружения и НИКУДА не пишется: ни в файл, ни в
 * вывод. В отчёт попадает только замаскированный вид.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const PATHS = require("../test/paths.cjs");

const TMP = PATHS.SCRATCH;
const TEST_EXT = path.join(TMP, "live-pb-ext");
const USER_DATA = PATHS.testProfile("livepb");
const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const CHROME = PATHS.CHROME;

const KEY = String(process.env.PB_KEY || "").trim();
if (!KEY) {
  console.error("нет ключа: запустите с PB_KEY=<ключ> node live-pixabay-check.cjs");
  process.exit(2);
}
const mask = (k) => (k.length <= 8 ? "…" : k.slice(0, 4) + "…" + k.slice(-2) + " (" + k.length + " зн.)");

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

/** Копия расширения как есть: адреса не подменяем — в этом весь смысл проверки. */
function prepareExtension() {
  copyDir(SRC_EXT, TEST_EXT);
  const bg = fs.readFileSync(path.join(TEST_EXT, "background.js"), "utf8");
  const real = 'const PIXABAY_API = "https://pixabay.com/api/";';
  // Контроль: если адрес в коде сменится, проверка «живая» перестанет быть живой.
  if (!bg.includes(real)) throw new Error("в background.js нет настоящего адреса Pixabay — проверка устарела");
  return TEST_EXT;
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
        }, 60000);
      })
  };
}

const hostOf = (u) => {
  try { return new URL(String(u)).host; } catch (e) { return ""; }
};

async function main() {
  prepareExtension();
  console.log("источник: %s", SRC_EXT);
  console.log("ключ: %s", mask(KEY));

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
    console.log("расширение: %s", extId);

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

    const setSettings = async (patch) => {
      const want = Object.keys(patch);
      let ok = false;
      for (let i = 0; i < 8; i++) {
        const res = await probeEval(`__send({ type: 'saveSettings', settings: ${JSON.stringify(patch)} })`);
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

    const send = (msg) => probeEval(`__send(${JSON.stringify(msg)})`);
    const clearCache = async () => { await send({ type: "clearCache" }); await sleep(250); };
    const cacheKeys = async () =>
      JSON.parse(await probeEval(
        `chrome.storage.local.get('dzrImages').then((s) => JSON.stringify(Object.keys(s.dzrImages || {})))`
      ));

    await setSettings({ imgSource: "pixabay", pixabayKey: KEY });
    await clearCache();

    // ---- 1. Настоящий запрос к Pixabay ------------------------------------
    console.log("\n=== 1. Живой запрос к Pixabay ===");
    const QUERY = "subaru outback wilderness";
    const t0 = Date.now();
    const res = await send({ type: "findImages", query: QUERY });
    const dt = Date.now() - t0;
    check("сервис ответил без ошибки", !!(res && res.ok), res && res.error ? res.error : dt + " мс");
    if (!res || !res.ok) throw new Error("живой запрос не удался: " + ((res && res.error) || "нет ответа"));

    const imgs = res.images || [];
    check("картинки пришли", imgs.length > 0, "получено " + imgs.length + " за " + dt + " мс");
    check("источник назван Pixabay", res.source === "Pixabay", "source=" + res.source);
    check("это не кэш: запрос ушёл в сеть", res.cached === false, "cached=" + res.cached);
    check("памятка о лицензии пришла", String(res.notice || "").includes("Pixabay"), "«" + String(res.notice || "").slice(0, 60) + "…»");
    check("кэш записал ровно один набор", (await cacheKeys()).length === 1, JSON.stringify(await cacheKeys()));

    const hosts = imgs.map((i) => hostOf(i.url));
    check("адреса картинок — с CDN Pixabay", hosts.length > 0 && hosts.every((h) => /pixabay\.com$/.test(h)),
      [...new Set(hosts)].join(", ") || "нет адресов");

    const noCredit = imgs.filter((i) => !/^Pixabay · \S/.test(String(i.credit || "")));
    check("у каждой картинки автор в подписи", noCredit.length === 0,
      noCredit.length ? "без автора: " + noCredit.length : "пример: «" + imgs[0].credit + "»");

    const noPage = imgs.filter((i) => !String(i.creditUrl || ""));
    check("у каждой картинки ссылка на страницу автора", noPage.length === 0,
      noPage.length ? "без ссылки: " + noPage.length : "пример: " + imgs[0].creditUrl);

    const tall = imgs.filter((i) => i.width && i.height && i.width <= i.height);
    check("вертикальные кадры отсеяны", tall.length === 0, tall.length ? "вертикальных: " + tall.length : "все горизонтальные");

    const noSize = imgs.filter((i) => !i.width || !i.height);
    check("у картинок есть размеры", noSize.length === 0,
      noSize.length ? "без размеров: " + noSize.length : "например " + imgs[0].width + "×" + imgs[0].height);

    const noExt = imgs.filter((i) => !/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(i.url));
    check("адреса похожи на картинки", noExt.length === 0, noExt.length ? "подозрительных: " + noExt.length : "");

    console.log("  первая: %s — %s", imgs[0].title || "(без подписи)", imgs[0].url);

    // ---- 2. Тот же запрос второй раз — из кэша ----------------------------
    console.log("\n=== 2. Повтор идёт из кэша ===");
    const again = await send({ type: "findImages", query: QUERY });
    check("повтор помечен как кэш", again.cached === true, "cached=" + again.cached);
    check("повтор отдал тот же набор",
      JSON.stringify((again.images || []).map((i) => i.url)) === JSON.stringify(imgs.map((i) => i.url)));
    check("наборов в кэше по-прежнему один", (await cacheKeys()).length === 1);

    // Регистр не должен плодить записи: та же фраза капсом — тот же ключ.
    const upper = await send({ type: "findImages", query: QUERY.toUpperCase() });
    check("фраза другим регистром — тот же кэш", upper.cached === true, "cached=" + upper.cached);
    check("записей в кэше не прибавилось", (await cacheKeys()).length === 1, JSON.stringify(await cacheKeys()));

    // ---- 3. Другой источник по той же фразе — снова в сеть ----------------
    console.log("\n=== 3. Другой источник по той же фразе идёт в сеть ===");
    await setSettings({ imgSource: "openverse" });
    const ov = await send({ type: "findImages", query: QUERY });
    check("Openverse ответил", !!(ov && ov.ok), ov && ov.error ? ov.error : "");
    if (ov && ov.ok) {
      check("ответ не подменён кэшем Pixabay", ov.cached === false, "cached=" + ov.cached);
      check("источник назван Openverse", ov.source === "Openverse", "source=" + ov.source);
      check("картинки пришли", (ov.images || []).length > 0, "получено " + (ov.images || []).length);
    }
    check("в кэше теперь два набора", (await cacheKeys()).length === 2, JSON.stringify(await cacheKeys()));

    // ---- 4. Чужой ключ: причина должна быть словами сервиса ---------------
    console.log("\n=== 4. Чужой ключ объясняется словами Pixabay ===");
    await setSettings({ imgSource: "pixabay" });
    await clearCache();
    const BAD = "0000000000000000000000000000000000000";
    const badCheck = await send({ type: "checkKey", kind: "images", overrides: { pixabayKey: BAD } });
    const badText = String((badCheck && (badCheck.text || badCheck.error)) || "");
    check("проверка ключа отказала", !badCheck || badCheck.ok === false || /HTTP 4\d\d/.test(badText),
      "«" + badText.slice(0, 140) + "»");
    check("отказ объяснён словами сервиса, а не кодом",
      /Invalid or missing API key|API key/i.test(badText), "«" + badText.slice(0, 140) + "»");

    const badFind = await send({ type: "findImages", query: QUERY, overrides: { pixabayKey: BAD } });
    const badFindText = String((badFind && (badFind.error || badFind.text)) || "");
    check("поиск с чужим ключом отказал", !badFind || badFind.ok === false,
      "«" + badFindText.slice(0, 140) + "»");
    check("и здесь причина названа словами сервиса",
      /Invalid or missing API key|API key/i.test(badFindText), "«" + badFindText.slice(0, 140) + "»");
    check("пустой ответ с чужим ключом в кэш не попал", (await cacheKeys()).length === 0,
      JSON.stringify(await cacheKeys()));

    // ---- 5. Рабочий ключ после неудачи по-прежнему работает ---------------
    console.log("\n=== 5. После отказа рабочий ключ работает ===");
    const good = await send({ type: "findImages", query: "mountain lake sunrise" });
    check("поиск с рабочим ключом снова нашёл", !!(good && good.ok && (good.images || []).length),
      good && good.error ? good.error : "найдено " + ((good && good.images) || []).length);
    check("и это снова живой запрос, не кэш", !!good && good.cached === false, "cached=" + (good && good.cached));
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
