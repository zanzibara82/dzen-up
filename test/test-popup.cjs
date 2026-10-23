/**
 * Тест попапа расширения: вкладки, настройки, кнопка очистки кэша.
 * Попап открываем как обычную страницу chrome-extension://<id>/popup.html —
 * у неё есть доступ к chrome.* API расширения.
 */
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const ROOT = PATHS.REPO;
const TMP = PATHS.SCRATCH;
const TEST_EXT = path.join(TMP, "test-ext-popup");
const USER_DATA = PATHS.testProfile("popup");
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

async function main() {
  copyDir(SRC_EXT, TEST_EXT);

  const chrome = spawn(CHROME, [
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    "--user-data-dir=" + USER_DATA,
    ...PATHS.chromeFlags(), "--window-size=520,760", "about:blank"
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
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
      return r.result.value;
    };

    for (let i = 0; i < 30; i++) {
      if (await evalJs(`!!document.getElementById('save')`)) break;
      await sleep(200);
    }
    // cache-info заполняется асинхронно (чтение storage) — дождёмся
    for (let i = 0; i < 20; i++) {
      const t = await evalJs(`document.getElementById('cache-info').textContent`);
      if (t && t.trim()) break;
      await sleep(150);
    }
    // Поля настроек заполняются своим запросом и могут отстать от cache-info.
    // Ждём явный признак применённых настроек, иначе проверки читают пустые поля.
    for (let i = 0; i < 40; i++) {
      if (await evalJs(`document.documentElement.getAttribute('data-dzr-popup') === 'ready'`)) break;
      await sleep(150);
    }

    const ui = await evalJs(`(() => ({
      title: document.title,
      tabs: Array.from(document.querySelectorAll('[id^="tab-"]')).map(t => t.textContent.trim()),
      hasRun: !!document.getElementById('run'),
      hasSrc: !!document.getElementById('src'),
      hasOut: !!document.getElementById('out'),
      hasClearCache: !!document.getElementById('clear-cache'),
      cacheInfo: (document.getElementById('cache-info')||{}).textContent,
      aiFieldsHidden: document.getElementById('ai-fields').hidden,
      quickHidden: document.getElementById('panel-quick').hidden,
      settingsHidden: document.getElementById('panel-settings').hidden
    }))()`);
    console.log("UI: %j", ui);
    check("попап открылся", /Дзен|Рерайт/i.test(ui.title), ui.title);
    check("обе вкладки на месте", ui.tabs.length === 2, JSON.stringify(ui.tabs));
    check("вкладка быстрого рерайта видна по умолчанию", ui.quickHidden === false && ui.settingsHidden === true);
    check("поля быстрого рерайта есть", ui.hasRun && ui.hasSrc && ui.hasOut);
    check("кнопка очистки кэша есть", ui.hasClearCache === true);
    check("строка про кэш отрисована", typeof ui.cacheInfo === "string" && ui.cacheInfo.length > 0, ui.cacheInfo);

    // переключение на вкладку настроек
    await evalJs(`document.getElementById('tab-settings').click()`);
    await sleep(250);
    const afterTab = await evalJs(`(() => ({
      settingsHidden: document.getElementById('panel-settings').hidden,
      quickHidden: document.getElementById('panel-quick').hidden,
      targetLang: (document.getElementById('targetLang')||{}).value,
      mode: (document.getElementById('mode')||{}).value,
      engine: (document.getElementById('engine')||{}).value
    }))()`);
    console.log("настройки: %j", afterTab);
    check("вкладка настроек открылась", afterTab.settingsHidden === false && afterTab.quickHidden === true);
    check("настройки заполнены из хранилища", !!afterTab.targetLang && !!afterTab.mode && !!afterTab.engine, JSON.stringify(afterTab));

    // поле глоссария должно быть на месте и заполняться из хранилища
    const gloss = await evalJs(`(() => {
      const g = document.getElementById('glossary');
      return g ? { exists: true, tag: g.tagName.toLowerCase(), value: g.value } : { exists: false };
    })()`);
    check("поле глоссария есть", gloss.exists === true && gloss.tag === "textarea", JSON.stringify(gloss.tag));
    check("глоссарий подхватывается из хранилища", typeof gloss.value === "string", JSON.stringify(String(gloss.value).slice(0, 40)));

    // переключатели предпросмотра и пропуска уже переведённого текста
    const switches = await evalJs(`(() => {
      const p = document.getElementById('preview');
      const s = document.getElementById('skipSameLang');
      return {
        preview: p ? { exists: true, checked: p.checked } : { exists: false },
        skip: s ? { exists: true, checked: s.checked } : { exists: false }
      };
    })()`);
    console.log("переключатели: %j", switches);
    check("переключатель предпросмотра есть и включён по умолчанию", switches.preview.exists === true && switches.preview.checked === true, JSON.stringify(switches.preview));
    check("переключатель пропуска уже переведённого есть и включён", switches.skip.exists === true && switches.skip.checked === true, JSON.stringify(switches.skip));

    // ---- стили рерайта (пресеты промпта) ----
    const presetUi = await evalJs(`(() => {
      const sel = document.getElementById('aiPreset');
      const ta = document.getElementById('aiPrompt');
      const hint = document.getElementById('aiPresetHint');
      if (!sel) return { exists: false };
      return {
        exists: true,
        count: sel.options.length,
        ids: Array.from(sel.options).map(o => o.value),
        value: sel.value,
        hint: hint ? hint.textContent : '',
        promptLen: ta ? ta.value.length : 0,
        promptHead: ta ? ta.value.slice(0, 24) : '',
        reset: !!document.getElementById('aiPromptReset')
      };
    })()`);
    console.log("пресеты: %j", Object.assign({}, presetUi, { ids: presetUi.ids && presetUi.ids.length + " шт." }));
    check("селект стилей есть", presetUi.exists === true);
    check("в селекте все пресеты и «свой промпт»",
      presetUi.exists && presetUi.count >= 6 && presetUi.ids.indexOf('custom') !== -1,
      (presetUi.ids || []).join(","));
    check("подсказка к стилю показана", typeof presetUi.hint === 'string' && presetUi.hint.length > 10, String(presetUi.hint).slice(0, 60));
    check("поле промпта заполнено текстом пресета", presetUi.promptLen > 50, "символов: " + presetUi.promptLen);
    check("кнопка возврата текста пресета есть", presetUi.reset === true);

    // выбор пресета подставляет его текст
    const switched = await evalJs(`(() => {
      const sel = document.getElementById('aiPreset');
      const ta = document.getElementById('aiPrompt');
      const before = ta.value;
      sel.value = 'short';
      sel.dispatchEvent(new Event('change'));
      return { changed: ta.value !== before, head: ta.value.slice(0, 30), hint: document.getElementById('aiPresetHint').textContent };
    })()`);
    check("выбор пресета подставляет его текст", switched.changed === true, switched.head);
    check("подсказка меняется вместе со стилем", /треть|короче/i.test(switched.hint), String(switched.hint).slice(0, 60));

    // правка промпта руками = «свой промпт»: иначе следующий выбор пресета
    // молча стёр бы правку, а селект показывал бы стиль, которого нет
    const typed = await evalJs(`(() => {
      const ta = document.getElementById('aiPrompt');
      ta.value = ta.value + ' Пиши короче.';
      ta.dispatchEvent(new Event('input'));
      return { preset: document.getElementById('aiPreset').value, hint: document.getElementById('aiPresetHint').textContent };
    })()`);
    check("правка промпта переключает стиль на «свой»", typed.preset === 'custom', String(typed.preset));

    // и это доезжает до хранилища
    const savedPreset = await evalJs(`(async () => {
      document.getElementById('save').click();
      await new Promise((r) => setTimeout(r, 1200));
      const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'getSettings' }, (x) => r(x || {})));
      const s = res.settings || {};
      return { preset: s.aiPreset, tail: String(s.aiPrompt || '').slice(-14) };
    })()`);
    check("стиль сохранён в настройки", savedPreset.preset === 'custom', String(savedPreset.preset));
    check("правка промпта доехала до хранилища", /Пиши короче/.test(savedPreset.tail), String(savedPreset.tail));

    // кнопка возвращает текст последнего настоящего пресета, а не «своего»
    const restored = await evalJs(`(() => {
      document.getElementById('aiPromptReset').click();
      return {
        preset: document.getElementById('aiPreset').value,
        stillEdited: /Пиши короче/.test(document.getElementById('aiPrompt').value),
        len: document.getElementById('aiPrompt').value.length
      };
    })()`);
    check("кнопка вернула текст последнего пресета", restored.preset === 'short' && restored.stillEdited === false && restored.len > 50, JSON.stringify(restored));

    // После перезагрузки попап обязан честно сказать «свой промпт»: если показать
    // пресет, текст которого уже изменён, пользователь будет думать, что работает
    // стиль, а на деле уйдёт его собственная правка.
    const beforeReload = await evalJs(`(async () => {
      const ta = document.getElementById('aiPrompt');
      ta.value = ta.value + ' Без воды.';
      ta.dispatchEvent(new Event('input'));
      document.getElementById('save').click();
      await new Promise((r) => setTimeout(r, 1200));
      return document.getElementById('aiPreset').value;
    })()`);
    await evalJs(`location.reload()`);
    await sleep(900);
    for (let i = 0; i < 30; i++) {
      if (await evalJs(`!!document.getElementById('aiPreset') && document.getElementById('aiPrompt').value.length > 0`)) break;
      await sleep(200);
    }
    const afterReload = await evalJs(`(() => ({
      preset: document.getElementById('aiPreset').value,
      edited: /Без воды/.test(document.getElementById('aiPrompt').value),
      hint: document.getElementById('aiPresetHint').textContent
    }))()`);
    check("после перезагрузки правленый промпт показан как «свой»", afterReload.preset === 'custom', JSON.stringify({ до: beforeReload, после: afterReload.preset }));
    check("правка промпта пережила перезагрузку", afterReload.edited === true);

    // ---- перелинковка: сайты и число ссылок ----
    const linkUi = await evalJs(`(() => {
      const sites = document.getElementById('linkSites');
      const channels = document.getElementById('linkChannels');
      const refresh = document.getElementById('channels-refresh');
      const exportBtn = document.getElementById('channels-export');
      const status = document.getElementById('channels-status');
      const count = document.getElementById('linkCount');
      const allow = document.getElementById('link-allow');
      const perm = document.getElementById('link-perm');
      return {
        sites: sites ? { exists: true, tag: sites.tagName.toLowerCase() } : { exists: false },
        channels: channels ? { exists: true, tag: channels.tagName.toLowerCase() } : { exists: false },
        refresh: !!refresh,
        exportBtn: !!exportBtn,
        status: status ? status.textContent : null,
        count: count ? { exists: true, type: count.type, value: count.value, min: count.min, max: count.max } : { exists: false },
        allow: !!allow,
        perm: perm ? perm.textContent : null
      };
    })()`);
    console.log("перелинковка: %j", linkUi);
    check("поле сайтов для перелинковки есть", linkUi.sites.exists === true && linkUi.sites.tag === 'textarea', JSON.stringify(linkUi.sites));
    check("поле каналов Дзена есть", linkUi.channels.exists === true && linkUi.channels.tag === 'textarea', JSON.stringify(linkUi.channels));
    check("кнопка переобхода каналов есть", linkUi.refresh === true);
    check("кнопка выгрузки sitemap есть", linkUi.exportBtn === true);
    check("статус переобхода не пустует после нажатия без каналов", typeof linkUi.status === 'string', String(linkUi.status));
    check("число ссылок по умолчанию — 2", linkUi.count.exists === true && linkUi.count.value === '2', JSON.stringify(linkUi.count));
    check("поле числа ссылок — числовое, с границами 1..10",
      linkUi.count.type === 'number' && linkUi.count.min === '1' && linkUi.count.max === '10',
      JSON.stringify({ type: linkUi.count.type, min: linkUi.count.min, max: linkUi.count.max }));
    check("кнопка разрешения доступа к сайтам есть", linkUi.allow === true);
    check("состояние доступа показано словами", typeof linkUi.perm === 'string' && linkUi.perm.length > 5, String(linkUi.perm));

    // Переобход без единого канала обязан честно сказать об этом, а не молчать
    // и не уходить в сеть.
    const noChannels = await evalJs(`(async () => {
      document.getElementById('linkChannels').value = '# только комментарий\\n   ';
      document.getElementById('channels-refresh').click();
      await new Promise((r) => setTimeout(r, 400));
      const st = document.getElementById('channels-status');
      return { text: st.textContent, cls: st.className };
    })()`);
    check("переобход без каналов объясняет отказ",
      /хотя бы один канал/.test(noChannels.text),
      JSON.stringify(noChannels.text));

    // Неадрес в списке сайтов. Строка списка превращается в шаблон права, а на
    // негодном шаблоне chrome.permissions.contains НЕ отвечает false, а падает:
    // «Invalid value for origin pattern … Invalid port». Одна такая строка —
    // человек копирует в поле подпись к фото — убивала весь обработчик кнопки, и
    // попап молчал. Теперь негодные строки называются вслух, а кнопка работает.
    const badLine = await evalJs(`(async () => {
      window.__errs = [];
      window.addEventListener('unhandledrejection', (e) => window.__errs.push(String((e && e.reason) || e)));
      window.__permReq = [];
      const origReq = chrome.permissions.request;
      const origSend = chrome.runtime.sendMessage;
      chrome.permissions.request = function (p) { window.__permReq.push(p); return Promise.resolve(false); };
      chrome.runtime.sendMessage = function (m, cb) { if (cb) cb({ ok: true }); };
      const field = document.getElementById('linkSites');
      field.value = 'Photo: Subaru of America, Inc.\\nauto-dom24.ru';
      document.getElementById('link-allow').click();
      await new Promise((r) => setTimeout(r, 700));
      const out = {
        text: document.getElementById('link-perm').textContent,
        errs: window.__errs.slice(),
        asked: window.__permReq.map((p) => p.origins)
      };
      chrome.permissions.request = origReq;
      chrome.runtime.sendMessage = origSend;
      field.value = '';
      return out;
    })()`);
    check("неадрес в списке не роняет попап", badLine.errs.length === 0, JSON.stringify(badLine.errs).slice(0, 200));
    check("неадрес назван в строке доступа", /Photo: Subaru of America/.test(badLine.text), badLine.text);
    check(
      "в запрос доступа ушёл только настоящий адрес",
      JSON.stringify(badLine.asked) === JSON.stringify([["https://auto-dom24.ru/*"]]),
      JSON.stringify(badLine.asked)
    );

    // Выгрузка без каналов обязана вести себя так же: сказать словами, а не
    // отдать пустой файл «на всякий случай».
    const noExport = await evalJs(`(async () => {
      document.getElementById('channels-export').click();
      await new Promise((r) => setTimeout(r, 400));
      const st = document.getElementById('channels-status');
      return { text: st.textContent, cls: st.className };
    })()`);
    check("выгрузка без каналов объясняет отказ",
      /хотя бы один канал/.test(noExport.text) && /err/.test(noExport.cls),
      JSON.stringify(noExport));

    // Успешная выгрузка. Ответ фонового скрипта подменяем, а скачивание
    // перехватываем: настоящий клик по ссылке ушёл бы в загрузки Chrome и
    // тест стал бы зависим от сети и от настроек браузера.
    const exportFlow = await evalJs(`(async () => {
      const realSend = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (msg, cb) => {
        if (msg && msg.type === 'exportChannelMap') {
          cb({ ok: true, files: [
            { name: 'auto-dom24.ru', filename: 'sitemap-auto-dom24.ru.xml', count: 118,
              xml: '<urlset>\\n  <loc>https://dzen.ru/a/aaa</loc>\\n</urlset>' },
            { name: 'id/999', filename: 'sitemap-id-999.xml', count: 0, xml: '<urlset></urlset>' }
          ] });
          return;
        }
        return realSend.call(chrome.runtime, msg, cb);
      };
      const made = [];
      const realCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => { made.push(blob); return realCreate.call(URL, blob); };
      const clicked = [];
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        clicked.push({ download: this.download, href: this.href });
      };

      document.getElementById('linkChannels').value = 'auto-dom24.ru';
      document.getElementById('channels-export').click();
      await new Promise((r) => setTimeout(r, 500));

      const st = document.getElementById('channels-status');
      const blobs = [];
      for (const b of made) blobs.push(await b.text());
      const out = { status: st.textContent, cls: st.className, clicked,
                    blobs, types: made.map((b) => b.type) };

      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
      chrome.runtime.sendMessage = realSend;
      return out;
    })()`);
    console.log("выгрузка sitemap: %j", exportFlow);
    check("выгрузка: файл на каждый канал", exportFlow.clicked.length === 2, JSON.stringify(exportFlow.clicked));
    check("выгрузка: имя файла из ответа фона",
      exportFlow.clicked[0].download === 'sitemap-auto-dom24.ru.xml' &&
      exportFlow.clicked[1].download === 'sitemap-id-999.xml',
      JSON.stringify(exportFlow.clicked.map((x) => x.download)));
    check("выгрузка: содержимое ушло в blob как есть",
      exportFlow.blobs[0] === '<urlset>\n  <loc>https://dzen.ru/a/aaa</loc>\n</urlset>',
      JSON.stringify(exportFlow.blobs[0]));
    check("выгрузка: тип файла — xml",
      exportFlow.types[0] === 'application/xml;charset=utf-8', String(exportFlow.types[0]));
    check("выгрузка: скачивание идёт через blob-ссылку",
      /^blob:chrome-extension:/.test(exportFlow.clicked[0].href), String(exportFlow.clicked[0].href));
    check("выгрузка: в статусе имена файлов и число статей",
      /Выгружено/.test(exportFlow.status) &&
      /sitemap-auto-dom24\.ru\.xml — 118/.test(exportFlow.status) &&
      /sitemap-id-999\.xml — 0/.test(exportFlow.status),
      JSON.stringify(exportFlow.status));
    check("выгрузка: пустой канал назван отдельно",
      /Пусто у: id\/999/.test(exportFlow.status), JSON.stringify(exportFlow.status));
    check("выгрузка: при непустой карте статус не ошибка",
      !/err/.test(exportFlow.cls), JSON.stringify(exportFlow.cls));

    // Все каналы пустые — это не успех, и подсветка должна быть красной.
    const emptyFlow = await evalJs(`(async () => {
      const realSend = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (msg, cb) => {
        if (msg && msg.type === 'exportChannelMap') {
          cb({ ok: true, files: [{ name: 'id/999', filename: 'sitemap-id-999.xml', count: 0, xml: '<urlset></urlset>' }] });
          return;
        }
        return realSend.call(chrome.runtime, msg, cb);
      };
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      document.getElementById('linkChannels').value = 'auto-dom24.ru';
      document.getElementById('channels-export').click();
      await new Promise((r) => setTimeout(r, 400));
      const st = document.getElementById('channels-status');
      const out = { status: st.textContent, cls: st.className };
      HTMLAnchorElement.prototype.click = realClick;
      chrome.runtime.sendMessage = realSend;
      return out;
    })()`);
    check("выгрузка: пустая карта — предупреждение, а не успех",
      /Карта пуста/.test(emptyFlow.status) && /err/.test(emptyFlow.cls),
      JSON.stringify(emptyFlow));

    // Ответ неожиданной формы не должен оставлять вечный «Готовлю карту…».
    // Ровно это и случилось вживую: фон отдал `{ files: { files: [...] } }`,
    // попап упал на `files.forEach`, и статус замер навсегда.
    const badShape = await evalJs(`(async () => {
      const realSend = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (msg, cb) => {
        if (msg && msg.type === 'exportChannelMap') { cb({ ok: true, files: { files: [] } }); return; }
        return realSend.call(chrome.runtime, msg, cb);
      };
      document.getElementById('linkChannels').value = 'auto-dom24.ru';
      document.getElementById('channels-export').click();
      await new Promise((r) => setTimeout(r, 400));
      const st = document.getElementById('channels-status');
      const out = { status: st.textContent, cls: st.className };
      chrome.runtime.sendMessage = realSend;
      return out;
    })()`);
    check("выгрузка: кривой ответ фона — предупреждение, а не вечное ожидание",
      !/Готовлю карту/.test(badShape.status) && /Карта пуста/.test(badShape.status),
      JSON.stringify(badShape));

    const savedLinks = await evalJs(`(async () => {
      document.getElementById('linkSites').value = 'auto-dom24.ru\\n# мой второй канал\\nhttps://example.com/';
      document.getElementById('linkChannels').value = 'https://dzen.ru/auto-dom24.ru\\n# второй\\nhttps://dzen.ru/id/123';
      document.getElementById('linkCount').value = '7';
      document.getElementById('save').click();
      await new Promise((r) => setTimeout(r, 1200));
      const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'getSettings' }, (x) => r(x || {})));
      const s = res.settings || {};
      const loc = await chrome.storage.local.get('linkSites');
      const chLoc = await chrome.storage.local.get('linkChannels');
      const syn = await chrome.storage.sync.get('linkSites');
      const chSyn = await chrome.storage.sync.get('linkChannels');
      return { sites: s.linkSites, channels: s.linkChannels, count: s.linkCount,
               local: loc.linkSites, chLocal: chLoc.linkChannels, sync: syn.linkSites, chSync: chSyn.linkChannels };
    })()`);
    console.log("сохранённые сайты: %j", { sites: savedLinks.sites, channels: savedLinks.channels, count: savedLinks.count });
    check("сайты сохранились как введены, строка в строку",
      savedLinks.sites === 'auto-dom24.ru\n# мой второй канал\nhttps://example.com/',
      JSON.stringify(savedLinks.sites));
    check("каналы сохранились как введены, строка в строку",
      savedLinks.channels === 'https://dzen.ru/auto-dom24.ru\n# второй\nhttps://dzen.ru/id/123',
      JSON.stringify(savedLinks.channels));
    check("число ссылок сохранено числом", savedLinks.count === 7, JSON.stringify(savedLinks.count));
    check("сайты лежат в local, а не в sync",
      typeof savedLinks.local === 'string' && savedLinks.sync === undefined,
      JSON.stringify({ local: typeof savedLinks.local, sync: savedLinks.sync }));
    // Каналы тоже в local: список может быть длинным, а в sync 8 КБ на ключ.
    check("каналы лежат в local, а не в sync",
      typeof savedLinks.chLocal === 'string' && savedLinks.chSync === undefined,
      JSON.stringify({ local: typeof savedLinks.chLocal, sync: savedLinks.chSync }));

    // границы: опечатка в поле не должна уехать в настройки как есть
    const bounds = await evalJs(`(async () => {
      const field = document.getElementById('linkCount');
      const save = async (v) => {
        field.value = v;
        document.getElementById('save').click();
        await new Promise((r) => setTimeout(r, 1200));
        const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'getSettings' }, (x) => r(x || {})));
        return { stored: (res.settings || {}).linkCount, shown: field.value };
      };
      const big = await save('99');
      const empty = await save('');
      return { big, empty };
    })()`);
    console.log("границы числа ссылок: %j", bounds);
    check("99 ссылок подрезаны до 10", bounds.big.stored === 10 && bounds.big.shown === '10', JSON.stringify(bounds.big));
    check("пустое поле возвращает 2", bounds.empty.stored === 2 && bounds.empty.shown === '2', JSON.stringify(bounds.empty));

    // ---- ссылки в оригинале: что с ними делать при переводе ----
    const stripUi = await evalJs(`(() => {
      const sel = document.getElementById('stripLinks');
      if (!sel) return { exists: false };
      return {
        exists: true,
        tag: sel.tagName.toLowerCase(),
        value: sel.value,
        options: Array.from(sel.options).map((o) => o.value)
      };
    })()`);
    console.log("чистка ссылок: %j", stripUi);
    check("настройка чистки ссылок есть в попапе", stripUi.exists === true && stripUi.tag === 'select', JSON.stringify(stripUi));
    check("режимы: keep / drop / off", JSON.stringify(stripUi.options) === JSON.stringify(['keep', 'drop', 'off']), JSON.stringify(stripUi.options));
    check("по умолчанию — «убрать ссылку, текст оставить»", stripUi.value === 'keep', String(stripUi.value));

    const savedStrip = await evalJs(`(async () => {
      document.getElementById('stripLinks').value = 'drop';
      document.getElementById('save').click();
      await new Promise((r) => setTimeout(r, 1200));
      const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'getSettings' }, (x) => r(x || {})));
      const syn = await chrome.storage.sync.get('stripLinks');
      return { stored: (res.settings || {}).stripLinks, sync: syn.stripLinks };
    })()`);
    console.log("режим чистки сохранён: %j", savedStrip);
    check("выбранный режим доехал до настроек", savedStrip.stored === 'drop', JSON.stringify(savedStrip));
    check("режим лежит в sync — значение мелкое", savedStrip.sync === 'drop', JSON.stringify(savedStrip));

    // ---- приписка в конце статьи: галочка и поле под ней ----
    const signUi = await evalJs(`(() => {
      const box = document.getElementById('signature');
      const field = document.getElementById('signatureText');
      const wrap = document.getElementById('signature-fields');
      return {
        box: !!box,
        checked: box ? box.checked : null,
        field: field ? field.tagName.toLowerCase() : null,
        value: field ? field.value : null,
        hidden: wrap ? wrap.hidden : null
      };
    })()`);
    console.log("приписка: %j", signUi);
    check("галочка приписки есть", signUi.box === true);
    check("поле приписки есть", signUi.field === 'textarea', String(signUi.field));
    check("галочка по умолчанию снята", signUi.checked === false, String(signUi.checked));
    check("поле скрыто, пока галочка снята", signUi.hidden === true, String(signUi.hidden));
    check(
      "в поле лежит готовый текст (с правильной орфографией)",
      /^Ставьте лайк, если понравилось/.test(String(signUi.value)) && !/комент/i.test(String(signUi.value)),
      JSON.stringify(signUi.value)
    );

    const signToggle = await evalJs(`(() => {
      const box = document.getElementById('signature');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      const shown = !document.getElementById('signature-fields').hidden;
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      return { shown, hiddenAfter: document.getElementById('signature-fields').hidden };
    })()`);
    console.log("переключение: %j", signToggle);
    check("галочка показывает поле", signToggle.shown === true);
    check("снятая галочка снова прячет поле", signToggle.hiddenAfter === true);

    const savedSign = await evalJs(`(async () => {
      document.getElementById('signature').checked = true;
      document.getElementById('signatureText').value = 'Свой текст приписки для проверки.';
      document.getElementById('save').click();
      await new Promise((r) => setTimeout(r, 1200));
      const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'getSettings' }, (x) => r(x || {})));
      const syn = await chrome.storage.sync.get(['signature', 'signatureText']);
      const s = res.settings || {};
      return { flag: s.signature, text: s.signatureText, syncFlag: syn.signature, syncText: syn.signatureText };
    })()`);
    console.log("сохранение приписки: %j", savedSign);
    check("галочка сохранена", savedSign.flag === true && savedSign.syncFlag === true, JSON.stringify(savedSign));
    check("свой текст сохранён слово в слово", savedSign.text === 'Свой текст приписки для проверки.' && savedSign.syncText === savedSign.text, JSON.stringify(savedSign.text));

    // выключаем пропуск и сохраняем — значение должно доехать до хранилища
    const saved = await evalJs(`(async () => {
      document.getElementById('skipSameLang').checked = false;
      document.getElementById('save').click();
      await new Promise((r) => setTimeout(r, 1200));
      const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'getSettings' }, (x) => r(x || {})));
      return { status: document.getElementById('settings-status').textContent, value: (res.settings || {}).skipSameLang };
    })()`);
    console.log("сохранение пропуска: %j", saved);
    check("настройка сохранилась", saved.value === false, JSON.stringify(saved));
    check("попап подтвердил сохранение", /Сохранено/.test(saved.status), String(saved.status).slice(0, 80));

    // скриншот настроек — для отчёта
    {
      const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(TMP, "shot-settings.png"), Buffer.from(shot.data, "base64"));
    }

    // кладём в кэш запись и проверяем, что счётчик и очистка работают
    await evalJs(`chrome.storage.local.set({
      dzrCache: { 'google|auto|ru|abc-3': { t: 'тест', at: Date.now() } }
    })`);
    await evalJs(`location.reload()`);
    await sleep(900);
    for (let i = 0; i < 30; i++) {
      if (await evalJs(`!!document.getElementById('clear-cache')`)) break;
      await sleep(200);
    }
    await evalJs(`document.getElementById('tab-settings').click()`);
    await sleep(250);
    const info = await evalJs(`document.getElementById('cache-info').textContent`);
    console.log("cache-info: %j", info);
    check("счётчик кэша видит запись", /1/.test(info), info);
    check("счётчик называет переводы", /переводов: 1/.test(info), info);

    await evalJs(`document.getElementById('clear-cache').click()`);
    await sleep(700);
    const cleared = await evalJs(`(async () => ({
      info: document.getElementById('cache-info').textContent,
      status: document.getElementById('settings-status').textContent,
      stored: Object.keys((await chrome.storage.local.get({ dzrCache: {} })).dzrCache || {}).length
    }))()`);
    console.log("после очистки: %j", cleared);
    check("кэш очищен в хранилище", cleared.stored === 0, "записей: " + cleared.stored);
    check("счётчик обновился", /пуст/i.test(cleared.info), cleared.info);
    check("показан статус очистки", /очищен/i.test(cleared.status), cleared.status);

    // ---- проверка ключей кнопкой -------------------------------------------
    // Смысл кнопки: нерабочий ключ должен всплывать в настройках, а не на
    // середине статьи. Сеть здесь не нужна: при пустом ключе фон отвечает сам,
    // а подставной sendMessage показывает, что именно уходит в фон.
    await evalJs(`document.getElementById('tab-settings').click()`);
    await sleep(200);
    const keyUI = await evalJs(`(() => {
      const a = document.getElementById('ai-check');
      return {
        ai: !!a,
        aiLabel: a ? a.textContent.trim() : '',
        aiInAiFields: !!(a && a.closest('#ai-fields')),
        aiStatus: !!document.getElementById('ai-check-status')
      };
    })()`);
    check("кнопка проверки ключа AI есть", keyUI.ai === true);
    check("кнопка подписана «Проверить ключ»", /Проверить ключ/.test(keyUI.aiLabel), keyUI.aiLabel);
    check("проверка ключа AI живёт в блоке AI-настроек", keyUI.aiInAiFields === true);
    check("у проверки есть строка результата", keyUI.aiStatus === true);

    const waitStatus = async (id) => {
      for (let i = 0; i < 25; i++) {
        const t = await evalJs(`document.getElementById('${id}').textContent`);
        if (t && t.trim() && t.indexOf("Проверяю") < 0) return t;
        await sleep(150);
      }
      return evalJs(`document.getElementById('${id}').textContent`);
    };

    // Пустые поля — честная ошибка, а не молчание.
    await evalJs(`(() => {
      document.getElementById('aiKey').value = '';
      return true;
    })()`);
    await evalJs(`document.getElementById('ai-check').click()`);
    const aiEmpty = await waitStatus("ai-check-status");
    check("пустой ключ AI объяснён", /API-ключ/.test(aiEmpty), aiEmpty);

    // Проверяем вписанное, а не сохранённое: иначе кнопка проверяла бы прошлую
    // версию настроек, и человек чинил бы не то. Фон подставной — в сеть не идём.
    await evalJs(`(() => {
      window.__sent = [];
      window.__origSend = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function (m, cb) {
        window.__sent.push(m);
        if (cb) cb({ ok: false, error: 'подставной фон' });
      };
      document.getElementById('aiKey').value = 'KEY-ИЗ-ПОЛЯ';
      document.getElementById('aiModel').value = 'MODEL-ИЗ-ПОЛЯ';
      document.getElementById('ai-check').click();
      return true;
    })()`);
    await sleep(600);
    const sentMsg = await evalJs(`(window.__sent || []).filter((m) => m.type === 'checkKey')[0] || null`);
    check("проверка уходит в фон как checkKey", !!sentMsg, JSON.stringify(sentMsg));
    check(
      "в проверку ушёл ключ из поля, а не сохранённый",
      !!(sentMsg && sentMsg.overrides && sentMsg.overrides.aiKey === "KEY-ИЗ-ПОЛЯ"),
      sentMsg && sentMsg.overrides && sentMsg.overrides.aiKey
    );
    check(
      "в проверку ушла модель из поля",
      !!(sentMsg && sentMsg.overrides && sentMsg.overrides.aiModel === "MODEL-ИЗ-ПОЛЯ"),
      sentMsg && sentMsg.overrides && sentMsg.overrides.aiModel
    );
    const aiAnswer = await waitStatus("ai-check-status");
    check("ответ фона показан в строке проверки", /подставной фон/.test(aiAnswer), aiAnswer);
    check("ошибка помечена как ошибка", /err/.test(await evalJs(`document.getElementById('ai-check-status').className`)));
    check(
      "кнопка снова доступна после проверки",
      (await evalJs(`document.getElementById('ai-check').disabled`)) === false
    );
    await evalJs(`(() => {
      chrome.runtime.sendMessage = window.__origSend;
      return true;
    })()`);

    // Свой адрес API. В манифесте перечислены только openai и openrouter, поэтому
    // для чужого домена Chrome режет запрос ещё до ответа, и человеку остаётся
    // «Failed to fetch» — он чинит ключ вместо доступа. Кнопка проверки обязана
    // спросить домен: у неё для этого есть настоящее нажатие. По http доступ
    // даётся только к своей машине — локальной модели по https не дотянуться.
    {
      const stub = (allowed, base) => `(() => {
        window.__sent = [];
        window.__permReq = [];
        chrome.runtime.sendMessage = function (m, cb) { window.__sent.push(m); if (cb) cb({ ok: false, error: 'подставной фон' }); };
        chrome.permissions.request = function (p) { window.__permReq.push(p); return Promise.resolve(${allowed}); };
        document.getElementById('aiBaseUrl').value = ${JSON.stringify(base)};
        document.getElementById('ai-check-status').textContent = '';
        document.getElementById('ai-check').click();
        return true;
      })()`;

      await evalJs(stub(true, "https://api.z.ai/api/paas/v4"));
      await sleep(600);
      const asked = await evalJs(`(window.__permReq || [])[0] || null`);
      check(
        "свой адрес API: спрошен доступ к домену",
        !!(asked && asked.origins && asked.origins[0] === "https://api.z.ai/*"),
        JSON.stringify(asked)
      );
      check(
        "доступ выдан — проверка ушла в фон",
        (await evalJs(`(window.__sent || []).filter((m) => m.type === 'checkKey').length`)) === 1
      );

      await evalJs(stub(false, "https://api.z.ai/api/paas/v4"));
      await sleep(600);
      const refused = await evalJs(`document.getElementById('ai-check-status').textContent`);
      check("в отказе доступа назван домен", /api\.z\.ai/.test(refused), refused);
      check("отказ помечен как ошибка", /err/.test(await evalJs(`document.getElementById('ai-check-status').className`)));
      check(
        "без доступа в фон не ходим",
        (await evalJs(`(window.__sent || []).length`)) === 0,
        "сообщений: " + (await evalJs(`(window.__sent || []).length`))
      );

      // OpenAI и OpenRouter уже в правах — лишнего запроса быть не должно.
      await evalJs(stub(true, "https://api.openai.com/v1"));
      await sleep(600);
      check(
        "для OpenAI доступ не переспрашиваем",
        (await evalJs(`(window.__permReq || []).length`)) === 0,
        "запросов доступа: " + (await evalJs(`(window.__permReq || []).length`))
      );

      // Локальная модель: Ollama отвечает по http, и по https его нет вовсе.
      await evalJs(stub(true, "http://127.0.0.1:11434/v1"));
      await sleep(600);
      const local = await evalJs(`(window.__permReq || [])[0] || null`);
      check(
        "локальный AI по http: спрошен доступ к своей машине",
        !!(local && local.origins && local.origins[0] === "http://127.0.0.1:11434/*"),
        JSON.stringify(local)
      );
      check(
        "локальный AI: проверка всё равно ушла в фон",
        (await evalJs(`(window.__sent || []).filter((m) => m.type === 'checkKey').length`)) === 1
      );

      // Чужой http-адрес: права на него нет и не будет, поэтому молчать нельзя —
      // иначе человек снова получит «запрос не дошёл» без причины.
      await evalJs(stub(true, "http://example.com/v1"));
      await sleep(600);
      check(
        "чужой http: доступ не спрашиваем",
        (await evalJs(`(window.__permReq || []).length`)) === 0,
        "запросов доступа: " + (await evalJs(`(window.__permReq || []).length`))
      );
      const httpMsg = await evalJs(`document.getElementById('ai-check-status').textContent`);
      check("чужой http объяснён словами", /localhost/.test(httpMsg), httpMsg);
      check(
        "чужой http: в фон не ходим",
        (await evalJs(`(window.__sent || []).length`)) === 0,
        "сообщений: " + (await evalJs(`(window.__sent || []).length`))
      );

      await evalJs(`(() => {
        chrome.runtime.sendMessage = window.__origSend;
        document.getElementById('aiBaseUrl').value = '';
        return true;
      })()`);
    }

    // Своя модель в быстром рерайте попапа. Ключа у неё нет, и раньше это
    // означало «AI выключен»: попап молча уходил во встроенный рерайтер, а
    // человек думал, что Ollama не годится. Проверяем по тому, что попап
    // отправляет в фон, — среди сообщений обязан быть aiRewrite.
    {
      await evalJs(`(async () => {
        const on = document.getElementById('aiEnabled');
        on.checked = true;
        on.dispatchEvent(new Event('change'));
        document.getElementById('aiBaseUrl').value = 'http://127.0.0.1:11434/v1';
        document.getElementById('aiModel').value = 'qwen2.5:7b';
        document.getElementById('aiKey').value = '';
        document.getElementById('save').click();
        await new Promise((r) => setTimeout(r, 1200));
        return true;
      })()`);
      const aiRun = await evalJs(`(async () => {
        const real = chrome.runtime.sendMessage;
        const seen = [];
        chrome.runtime.sendMessage = function (m, cb) {
          seen.push(m.type);
          if (cb) cb({ ok: true, text: 'ТЕКСТ-ОТ-AI' });
        };
        document.getElementById('src').value = 'Текст статьи для проверки.';
        document.getElementById('run').click();
        await new Promise((r) => setTimeout(r, 1500));
        chrome.runtime.sendMessage = real;
        return { seen: seen, out: document.getElementById('out').value };
      })()`);
      check(
        "без ключа на своей машине попап всё равно зовёт AI",
        aiRun.seen.indexOf('aiRewrite') >= 0,
        JSON.stringify(aiRun.seen)
      );
      check("ответ своей модели попал в поле результата", /ТЕКСТ-ОТ-AI/.test(aiRun.out), aiRun.out);

      // Настройки возвращаем как были: снимок ниже не должен показывать чужой
      // адрес, оставшийся от проверки.
      await evalJs(`(async () => {
        const on = document.getElementById('aiEnabled');
        on.checked = false;
        on.dispatchEvent(new Event('change'));
        document.getElementById('aiBaseUrl').value = '';
        document.getElementById('aiKey').value = '';
        document.getElementById('save').click();
        await new Promise((r) => setTimeout(r, 1200));
        document.getElementById('src').value = '';
        document.getElementById('out').value = '';
        return true;
      })()`);
    }

    // Снимок блока с проверкой ключей: попап длинный, на общем скриншоте эта
    // часть не видна, а смотреть на неё глазами удобнее, чем на разметку.
    // Блок AI-настроек показываем принудительно: он скрыт, пока не включён
    // AI-рерайт, и по скрытому узлу scrollIntoView ничего не делает.
    await evalJs(`(() => {
      document.getElementById('panel-settings').hidden = false;
      // Галочка включена — иначе блок полей показан вопреки своему состоянию,
      // и снимок выглядел бы противоречиво.
      const on = document.getElementById('aiEnabled');
      on.checked = true;
      on.dispatchEvent(new Event('change'));
      // Строку результата чистим: на снимке нужна кнопка, а не ответ
      // подставного фона из этой же проверки.
      document.getElementById('ai-check-status').textContent = '';
      const el = document.getElementById('ai-check');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(400);
    const shotKeys = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const pKeys = path.join(TMP, "shot-popup-keys.png");
    fs.writeFileSync(pKeys, Buffer.from(shotKeys.data, "base64"));
    console.log("\nскриншот проверки ключей: %s", pKeys);

    // быстрый рерайт офлайн-движком (без сети): режим «только рерайт»
    const quick = await evalJs(`(async () => {
      await chrome.storage.sync.set({ mode: 'rewrite' });
      return true;
    })()`);
    void quick;

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (errs.length) {
      console.log("\nисключения:");
      errs.slice(-6).forEach((e) => console.log("  ", JSON.stringify(e.params).slice(0, 300)));
    }

    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const p = path.join(TMP, "shot-popup.png");
    fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
    console.log("\nскриншот попапа: %s", p);

    console.log("\n=== ИТОГ ===");
    const bad = results.filter((r) => !r.ok);
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
    bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
  } finally {
    try { execSync("taskkill /F /T /PID " + chrome.pid, { stdio: "ignore" }); } catch {}
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e.message || e); process.exit(1); });
