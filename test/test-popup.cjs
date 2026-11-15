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
    await c.send("Page.enable", {}, sessionId);
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

    // ---- проверка обновлений ----
    // Распакованное расширение не обновляет себя само, поэтому кнопка обязана
    // назвать чужую версию и отдать команду пересборки. Сеть подменяем: тест не
    // должен зависеть от GitHub, а «обновлений нет» при недоступном репозитории
    // — это ровно та ложь, ради которой написан этот набор.
    const updUi = await evalJs(`(() => {
      const btn = document.getElementById('update-check');
      const copy = document.getElementById('update-copy');
      const st = document.getElementById('update-status');
      return {
        btn: !!btn,
        copy: !!copy,
        copyHidden: !!copy && copy.hidden,
        status: st ? st.textContent : null
      };
    })()`);
    console.log("проверка обновлений: %j", updUi);
    check("кнопка проверки обновлений есть", updUi.btn === true);
    check("кнопка копирования команды есть и спрятана до находки", updUi.copy === true && updUi.copyHidden === true, JSON.stringify(updUi));

    const updNewer = await evalJs(`(async () => {
      const realSend = chrome.runtime.sendMessage;
      const realContains = chrome.permissions.contains;
      const realReq = chrome.permissions.request;
      const asked = [];
      const msgs = [];
      chrome.permissions.contains = (p) => Promise.resolve(false);
      chrome.permissions.request = (p) => { asked.push(p.origins); return Promise.resolve(true); };
      chrome.runtime.sendMessage = (msg, cb) => {
        if (msg && msg.type === 'checkUpdate') {
          msgs.push(msg.type);
          cb({ ok: true, state: 'update', current: '2.1.1', remote: '2.2.0',
               command: 'git pull && node tools/build-extension.cjs' });
          return;
        }
        return realSend.call(chrome.runtime, msg, cb);
      };
      const copied = [];
      // Буфер перехватываем на месте: присвоить navigator.clipboard нельзя
      // (свойство у Navigator только для чтения), и проверка записала бы
      // настоящую команду в настоящий буфер человека.
      const clip = navigator.clipboard;
      const realWrite = clip.writeText;
      clip.writeText = (t) => { copied.push(t); return Promise.resolve(); };

      document.getElementById('update-check').click();
      await new Promise((r) => setTimeout(r, 400));
      const st1 = document.getElementById('update-status');
      const found = { status: st1.textContent, cls: st1.className, copyHidden: document.getElementById('update-copy').hidden,
                      btnDisabled: document.getElementById('update-check').disabled };
      document.getElementById('update-copy').click();
      await new Promise((r) => setTimeout(r, 300));
      const out = { found, asked, msgs, copied, copyStatus: document.getElementById('update-status').textContent };
      clip.writeText = realWrite;
      chrome.runtime.sendMessage = realSend;
      chrome.permissions.contains = realContains;
      chrome.permissions.request = realReq;
      return out;
    })()`);
    console.log("находка обновления: %j", updNewer);
    check("доступ спрашивается ровно к домену манифеста",
      JSON.stringify(updNewer.asked) === JSON.stringify([["https://raw.githubusercontent.com/*"]]),
      JSON.stringify(updNewer.asked));
    check("находка названа обоими номерами",
      /2\.1\.1/.test(updNewer.found.status) && /2\.2\.0/.test(updNewer.found.status),
      JSON.stringify(updNewer.found.status));
    check("при находке статус не ошибка", !/err/.test(updNewer.found.cls), JSON.stringify(updNewer.found.cls));
    check("при находке кнопка копирования показана", updNewer.found.copyHidden === false);
    check("после ответа кнопка снова активна", updNewer.found.btnDisabled === false);
    check("в буфер ушла команда из ответа фона",
      updNewer.copied.length === 1 && updNewer.copied[0] === 'git pull && node tools/build-extension.cjs',
      JSON.stringify(updNewer.copied));
    check("копирование подтверждено словами", /Скопировано|буфер/.test(updNewer.copyStatus), JSON.stringify(updNewer.copyStatus));

    const updStates = await evalJs(`(async () => {
      const realSend = chrome.runtime.sendMessage;
      const realContains = chrome.permissions.contains;
      const out = {};
      chrome.permissions.contains = () => Promise.resolve(true);
      const run = async (res) => {
        chrome.runtime.sendMessage = (msg, cb) => {
          if (msg && msg.type === 'checkUpdate') { cb(res); return; }
          return realSend.call(chrome.runtime, msg, cb);
        };
        document.getElementById('update-check').click();
        await new Promise((r) => setTimeout(r, 400));
        const st = document.getElementById('update-status');
        return { status: st.textContent, cls: st.className, copyHidden: document.getElementById('update-copy').hidden };
      };
      out.latest = await run({ ok: true, state: 'latest', current: '2.1.1', remote: '2.1.1' });
      out.ahead = await run({ ok: true, state: 'ahead', current: '2.2.0', remote: '2.1.1' });
      out.error = await run({ ok: false, error: 'GitHub: запрос не дошёл — нет доступа к raw.githubusercontent.com' });
      out.junk = await run({ ok: true });
      chrome.runtime.sendMessage = realSend;
      chrome.permissions.contains = realContains;
      return out;
    })()`);
    console.log("состояния проверки: %j", updStates);
    check("равные версии — сказаны словами «обновлений нет»",
      /обновлений нет/i.test(updStates.latest.status) && updStates.latest.copyHidden === true,
      JSON.stringify(updStates.latest));
    check("установленная новее — обновление не предлагается",
      /новее/i.test(updStates.ahead.status) && updStates.ahead.copyHidden === true,
      JSON.stringify(updStates.ahead));
    check("сбой GitHub назван ошибкой, а не «обновлений нет»",
      /err/.test(updStates.error.cls) && !/обновлений нет/i.test(updStates.error.status) &&
      updStates.error.copyHidden === true,
      JSON.stringify(updStates.error));
    check("кривой ответ не оставляет вечного «Проверяю…»",
      !/Проверяю/.test(updStates.junk.status) && /err/.test(updStates.junk.cls),
      JSON.stringify(updStates.junk));

    const updRefused = await evalJs(`(async () => {
      const realSend = chrome.runtime.sendMessage;
      const realContains = chrome.permissions.contains;
      const realReq = chrome.permissions.request;
      const msgs = [];
      chrome.permissions.contains = () => Promise.resolve(false);
      chrome.permissions.request = () => Promise.resolve(false);
      chrome.runtime.sendMessage = (msg, cb) => {
        if (msg && msg.type === 'checkUpdate') { msgs.push(msg.type); cb({ ok: true, state: 'update', current: '1', remote: '2' }); return; }
        return realSend.call(chrome.runtime, msg, cb);
      };
      document.getElementById('update-check').click();
      await new Promise((r) => setTimeout(r, 400));
      const st = document.getElementById('update-status');
      const out = { status: st.textContent, cls: st.className, msgs,
                    btnDisabled: document.getElementById('update-check').disabled,
                    copyHidden: document.getElementById('update-copy').hidden };
      chrome.runtime.sendMessage = realSend;
      chrome.permissions.contains = realContains;
      chrome.permissions.request = realReq;
      return out;
    })()`);
    check("отказ в доступе назван ошибком и объяснён",
      /err/.test(updRefused.cls) && /доступ/.test(updRefused.status), JSON.stringify(updRefused));
    check("без доступа запрос фону не уходит",
      updRefused.msgs.length === 0 && updRefused.copyHidden === true, JSON.stringify(updRefused));

    // ---- выбор папки и рукоять (автообновление) ----------------------------
    // «Обновить сейчас» пишет файлы в папку установки, и этот шаг невозможно
    // проверить без подставной рукояти: диалог поднимает только живой жест.
    // Проверки ниже отвечают на три вопроса: диалог не поднимается вторично,
    // запрос права происходит синхронно с кликом (иначе Chrome его отклонит),
    // и чужая папка не сохраняется как своя.
    {
      try {
          // Имя берём из собранного манифеста: попап сравнивает выбор с
          // chrome.runtime.getManifest().name, и захардкоженное имя разъехалось
          // бы с реальным при первом же переименовании расширения.
          const realName = JSON.parse(fs.readFileSync(path.join(SRC_EXT, "manifest.json"), "utf8")).name;
          const goodManifest = { "manifest.json": JSON.stringify({ manifest_version: 3, name: realName, version: "2.2.0" }) };
          const enc = (s) => new TextEncoder().encode(s);
          const manifestTo = JSON.stringify({ manifest_version: 3, name: realName, version: "2.3.0" });
          // Пакет по умолчанию несёт один изменённый манифест: этого хватает,
          // чтобы проверить запись, резерв, журнал и перезагрузку целиком.
          const defaultPkg = { ok: true, current: "2.2.0", remote: "2.3.0", files: [{ path: "manifest.json", bytes: enc(manifestTo) }] };
          // Байты едут в подставной фон массивами и собираются в Uint8Array на
          // странице: JSON.stringify(Uint8Array) дал бы объект с числовыми ключами.
          const pkgPayload = (pkg) => JSON.stringify({
            ok: pkg.ok !== false, current: pkg.current, remote: pkg.remote,
            files: (pkg.files || []).map((f) => ({ path: f.path, bytes: Array.from(f.bytes) }))
          });
          // Один прогон: фикстуры и подставной диалог ставятся ДО загрузки попапа
          // (Page.addScriptToEvaluateOnNewDocument), потому что попап читает рукоять
          // при открытии и жест обязан быть синхронным с кликом. `seed` закладывает
          // рукоять в память-IndexedDB до чтения; `ask` — что отдаст
          // requestPermission; `picker` — живой ли диалог. После reload клик по
          // «Обновить сейчас» и сбор исхода.
          const pickCase = async (o) => {
            const fix = ["fake-dir-handle.cjs", "memory-idb.cjs"]
              .map((f) => fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8")).join("\n;\n");
            const setup = `(function () {
              var root = makeFakeRoot(${JSON.stringify(o.files || {})}, { permission: ${o.query === false ? '"denied"' : '"granted"'}, request: ${o.ask === false ? "false" : "true"}${o.failOn ? ", failOn: " + JSON.stringify(o.failOn) : ""}${o.failRel ? ", failRel: " + JSON.stringify(o.failRel) : ""} });
              var mem = globalThis.memoryIdb;
              var db = mem.open('dzr-update').__db;
              db.createObjectStore('handles');
              ${o.seed ? "mem.seed(db, root);" : ""}
              window.__pick = { root: root, db: db, journal: [], sent: [], gestureSync: null, afterClick: false, reloads: 0 };
              // Журнал изолируется между кейсами: chrome.storage переживает reload,
              // и чужой журнал прошлого кейса поднял бы кнопки восстановления.
              chrome.storage.local.remove('dzrUpdateIntent');
              ${o.intent ? "chrome.storage.local.set({ dzrUpdateIntent: " + JSON.stringify(o.intent) + " });" : ""}
              // Версию в памяти подменяем для исходов A/B: после настоящего reload
              // она стала бы новой, а исход B — это «диск новый, память старый».
              var realGetManifest = chrome.runtime.getManifest.bind(chrome.runtime);
              chrome.runtime.getManifest = function () {
                var m = realGetManifest();
                return Object.assign({}, m, { version: ${JSON.stringify(o.manifestVersion || "")} || m.version });
              };
              // indexedDB — аксессор только с геттером на прототипе Window:
              // голое присваивание в нестрогом режиме молча теряется, и попап
              // писал бы в настоящую базу, где рукоять не клонируется.
              Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open: function (name) { return mem.open(name); } } });
              // reload в браузерном наборе выгрузил бы расширение насовсем —
              // считаем вызовы шпионом, а не перезагружаем страницу по-настоящему.
              chrome.runtime.reload = function () { window.__pick.reloads++; };
              var realReq = root.requestPermission.bind(root);
              root.requestPermission = function (d) {
                if (window.__pick.gestureSync === null) window.__pick.gestureSync = !window.__pick.afterClick;
                return realReq(d);
              };
              window.showDirectoryPicker = function (opts) {
                window.__pick.journal.push('picker:' + ((opts && opts.mode) || '?'));
                if (window.__pick.gestureSync === null) window.__pick.gestureSync = !window.__pick.afterClick;
                return ${o.picker === false ? "Promise.reject(Object.assign(new Error('user cancelled'), { name: 'AbortError' }))" : "Promise.resolve(root)"};
              };
              var realSend = chrome.runtime.sendMessage;
              chrome.runtime.sendMessage = function (msg, cb) {
                if (msg && msg.type === 'updatePackage') {
                  window.__pick.sent.push(msg.type);
                  var pkg = ${pkgPayload(o.pkg || defaultPkg)};
                  pkg.files.forEach(function (f) { f.bytes = new Uint8Array(f.bytes); });
                  cb(pkg);
                  return;
                }
                return realSend.apply(chrome.runtime, arguments);
              };
            })();`;
            const { identifier } = await c.send("Page.addScriptToEvaluateOnNewDocument", { source: fix + "\n;\n" + setup }, sessionId);
            try {
              await c.send("Page.reload", {}, sessionId);
              for (let i = 0; i < 50; i++) {
                if (await evalJs(`document.documentElement?.getAttribute('data-dzr-popup') === 'ready' && !!document.getElementById('update-apply') && !!window.__pick`)) break;
                await sleep(150);
              }
              return await evalJs(`(async () => {
                var p = window.__pick;
                p.afterClick = false; p.gestureSync = null; p.journal = []; p.sent = [];
                // Метка в chrome.storage: обновление не должно трогать настройки
                // и ключ — они живут в профиле, а не в папке установки.
                await chrome.storage.local.set({ dzrSentinel: 'секрет-не-трогать' });
                // Микрозадача, поставленная до клика, отмечает «стек размотался»:
                // жест, вызванный раньше неё, синхронный (до первого await).
                Promise.resolve().then(function () { p.afterClick = true; });
                var action = ${JSON.stringify(o.action || "apply")};
                if (action === 'apply') { var btn = document.getElementById('update-apply'); btn.hidden = false; btn.click(); }
                else if (action === 'resume') { document.getElementById('update-resume').click(); }
                else if (action === 'restore') { document.getElementById('update-restore').click(); }
                await new Promise((r) => setTimeout(r, 1200));
                var st = document.getElementById('update-status');
                var files = {};
                Object.keys(p.root.__files).forEach(function (k) { files[k] = new TextDecoder().decode(p.root.__files[k]); });
                var intentRes = await chrome.storage.local.get('dzrUpdateIntent');
                var sentinelRes = await chrome.storage.local.get('dzrSentinel');
                return {
                  status: st.textContent, cls: st.className,
                  journal: p.journal, sync: p.gestureSync, sent: p.sent,
                  saved: !!p.db.__store['install-dir'], sameHandle: p.db.__store['install-dir'] === p.root,
                  reloads: p.reloads, files: files, calls: p.root.__calls.slice(),
                  intent: intentRes.dzrUpdateIntent || null, sentinel: sentinelRes.dzrSentinel,
                  resumeHidden: document.getElementById('update-resume').hidden,
                  restoreHidden: document.getElementById('update-restore').hidden,
                  restoreLabel: document.getElementById('update-restore').textContent
                };
              })()`);
            } finally {
              await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sessionId);
            }
          };

          const noHandle = await pickCase({ files: goodManifest, picker: true });
          console.log("выбор без рукояти: %j", noHandle);
          check("без сохранённой рукояти диалог поднимается",
            noHandle.journal.join() === "picker:readwrite", JSON.stringify(noHandle.journal));
          check("жест делается синхронно с кликом, до первого ожидания",
            noHandle.sync === true, JSON.stringify(noHandle.sync));
          check("после выбора рукоять сохранена в IndexedDB",
            noHandle.saved === true && noHandle.sameHandle === true, JSON.stringify({ saved: noHandle.saved, same: noHandle.sameHandle }));

          const withHandle = await pickCase({ files: goodManifest, seed: true, picker: true });
          console.log("выбор с рукоятью: %j", withHandle);
          check("рукоять на месте — диалог не поднимается",
            withHandle.journal.join() === "", JSON.stringify(withHandle.journal));
          check("пакет обновления запрошен у фона",
            withHandle.sent.join() === "updatePackage", JSON.stringify(withHandle.sent));

          const refused = await pickCase({ files: goodManifest, seed: true, ask: false });
          console.log("отказ в праве: %j", refused);
          check("отказ в праве назван причиной, а не успехом",
            /err/.test(refused.cls) && /доступ|прав/i.test(refused.status) && !/обновлено/i.test(refused.status),
            JSON.stringify(refused));
          check("при отказе в фон не ходим", refused.sent.length === 0, JSON.stringify(refused.sent));

          const cancelled = await pickCase({ files: goodManifest, picker: false });
          console.log("отмена диалога: %j", cancelled);
          check("отмена диалога — статус без обещания обновления",
            !/обновлено/i.test(cancelled.status) && /выбор|папк/i.test(cancelled.status),
            JSON.stringify(cancelled));

          const foreign = await pickCase({
            files: { "manifest.json": JSON.stringify({ manifest_version: 3, name: "Какое-то другое расширение", version: "1.0.0" }) },
            seed: true
          });
          console.log("чужая папка: %j", foreign);
          check("чужая папка названа словами «не то расширение»",
            /err/.test(foreign.cls) && /не то расширение/.test(foreign.status), JSON.stringify(foreign));
          check("рукоять чужой папки не сохраняется",
            foreign.saved === false, JSON.stringify(foreign.saved));

          const notDir = await pickCase({ files: { "readme.txt": "просто файл" }, seed: true });
          console.log("папка без манифеста: %j", notDir);
          check("папка без манифеста названа причиной",
            /err/.test(notDir.cls) && /манифест/i.test(notDir.status) && notDir.sent.length === 0,
            JSON.stringify(notDir));

          const moved = await pickCase({ files: goodManifest, seed: true, failOn: "entries" });
          console.log("папку перенесли: %j", moved);
          check("перенесённую папку не выдают за отсутствующий файл",
            /err/.test(moved.cls) && /на месте нет/.test(moved.status) && moved.saved === false,
            JSON.stringify(moved));

          const named = await pickCase({ files: goodManifest, seed: true });
          check("статус называет папку, куда пишем",
            /dzen-rewriter|папк/i.test(named.status) && /2\.2\.0/.test(named.status) && /2\.3\.0/.test(named.status),
            JSON.stringify(named.status));

          // ---- запись пакета на диск (автообновление) ------------------------
          // Выбор папки проверен выше; здесь сам клик должен записать новые
          // байты, завести журнал до первой записи, положить старые в резерв и
          // перезагрузить расширение. Манифест — последним, иначе полусостояние.
          check("пакет записан на диск — манифест новой версии",
            /2\.3\.0/.test(noHandle.files["manifest.json"] || ""), noHandle.files["manifest.json"]);
          check("старые байты лежат в резерве .dzr-backup/<from>/",
            /2\.2\.0/.test(noHandle.files[".dzr-backup/2.2.0/manifest.json"] || ""),
            JSON.stringify(Object.keys(noHandle.files)));
          check("журнал заведён до записи и помечен written",
            !!noHandle.intent && noHandle.intent.written === true && noHandle.intent.from === "2.2.0" && noHandle.intent.to === "2.3.0",
            JSON.stringify(noHandle.intent));
          const noHandleCloses = noHandle.calls.filter((x) => x.indexOf("close:") === 0);
          check("манифест записан последним",
            noHandleCloses[noHandleCloses.length - 1] === "close:manifest.json", noHandleCloses.join(", "));
          check("расширение перезагружено один раз", noHandle.reloads === 1, JSON.stringify(noHandle.reloads));
          check("настройки и ключ при записи не тронуты",
            noHandle.sentinel === "секрет-не-трогать" && (!noHandle.intent || noHandle.intent.aiKey === undefined),
            JSON.stringify({ sentinel: noHandle.sentinel, intent: noHandle.intent }));

          // Отказ диска посередине: уже записанное возвращается к старым байтам,
          // журнал прерван, перезагрузки нет — установка не осталась полусостоянием.
          const rollback = await pickCase({
            files: { "manifest.json": goodManifest["manifest.json"], "popup.js": "старый попап" },
            seed: true,
            pkg: { ok: true, current: "2.2.0", remote: "2.3.0", files: [
              { path: "popup.js", bytes: enc("новый попап") },
              { path: "manifest.json", bytes: enc(manifestTo) }
            ] },
            failOn: "write", failRel: "manifest.json"
          });
          console.log("откат при отказе диска: %j", rollback);
          check("отказ диска назван ошибкой, а не успехом",
            /err/.test(rollback.cls) && /оборвалась|возвращены|откат/i.test(rollback.status), rollback.status);
          check("уже записанный файл возвращён к старым байтам",
            rollback.files["popup.js"] === "старый попап", rollback.files["popup.js"]);
          check("манифест при откате остался прежней версии",
            /2\.2\.0/.test(rollback.files["manifest.json"] || "") && !/2\.3\.0/.test(rollback.files["manifest.json"] || ""),
            rollback.files["manifest.json"]);
          check("журнал помечен прерванным, без written",
            !!rollback.intent && rollback.intent.aborted === true && !rollback.intent.written,
            JSON.stringify(rollback.intent));
          check("при откате расширение не перезагружается", rollback.reloads === 0, JSON.stringify(rollback.reloads));

          // ---- шесть исходов: журнал при открытии попапа ---------------------
          // Журнал переживает смерть попапа, поэтому следующее открытие обязано
          // понять, чем кончилось прошлое обновление, и дать выход в один клик.
          const outcomeA = await pickCase({
            files: goodManifest, seed: true, action: "inspect", manifestVersion: "2.3.0",
            intent: { from: "2.2.0", to: "2.3.0", at: 1, written: true }
          });
          console.log("исход A (перечитал): %j", outcomeA);
          check("исход A: «Обновлено до» и журнал снят",
            /Обновлено до 2\.3\.0/.test(outcomeA.status) && outcomeA.intent === null, JSON.stringify({ status: outcomeA.status, intent: outcomeA.intent }));
          check("исход A: кнопок восстановления нет",
            outcomeA.resumeHidden === true && outcomeA.restoreHidden === true, JSON.stringify({ resume: outcomeA.resumeHidden, restore: outcomeA.restoreHidden }));

          const outcomeB = await pickCase({
            files: goodManifest, seed: true, action: "inspect", manifestVersion: "2.2.0",
            intent: { from: "2.2.0", to: "2.3.0", at: 1, written: true }
          });
          console.log("исход B (не перечитал): %j", outcomeB);
          check("исход B: файлы новые, браузер не перечитал — подсказка про ⟳",
            /не перечитал/.test(outcomeB.status) && /⟳/.test(outcomeB.status) && /2\.3\.0/.test(outcomeB.status), outcomeB.status);
          check("исход B: журнал остаётся до перечитки, кнопок нет",
            !!outcomeB.intent && outcomeB.intent.written === true && outcomeB.resumeHidden === true, JSON.stringify(outcomeB.intent));

          const outcomeD = await pickCase({
            files: goodManifest, seed: true, action: "inspect",
            intent: { from: "2.2.0", to: "2.3.0", at: 1 }
          });
          console.log("исход D (не завершено): %j", outcomeD);
          check("исход D: статус называет диск и ожидаемую версию",
            /не завершено/.test(outcomeD.status) && /2\.2\.0/.test(outcomeD.status) && /2\.3\.0/.test(outcomeD.status), outcomeD.status);
          check("исход D: показаны «Дописать» и «Вернуть 2.2.0»",
            outcomeD.resumeHidden === false && outcomeD.restoreHidden === false && outcomeD.restoreLabel === "Вернуть 2.2.0",
            JSON.stringify({ resume: outcomeD.resumeHidden, restore: outcomeD.restoreHidden, label: outcomeD.restoreLabel }));

          const resumed = await pickCase({
            files: goodManifest, seed: true, action: "resume",
            intent: { from: "2.2.0", to: "2.3.0", at: 1 }
          });
          console.log("дописать: %j", resumed);
          check("«Дописать» дописывает пакет и перезагружает",
            /2\.3\.0/.test(resumed.files["manifest.json"] || "") && resumed.intent && resumed.intent.written === true && resumed.reloads === 1,
            JSON.stringify({ manifest: resumed.files["manifest.json"], intent: resumed.intent, reloads: resumed.reloads }));
          check("«Дописать» запрашивает право синхронно с кликом", resumed.sync === true, JSON.stringify(resumed.sync));

          const restored = await pickCase({
            files: {
              "manifest.json": JSON.stringify({ manifest_version: 3, name: realName, version: "2.3.0" }),
              "popup.js": "новый попап",
              ".dzr-backup/2.2.0/manifest.json": goodManifest["manifest.json"],
              ".dzr-backup/2.2.0/popup.js": "старый попап"
            },
            seed: true, action: "restore",
            intent: { from: "2.2.0", to: "2.3.0", at: 1 }
          });
          console.log("вернуть: %j", restored);
          check("«Вернуть» возвращает файлы из резерва на диске",
            /2\.2\.0/.test(restored.files["manifest.json"] || "") && restored.files["popup.js"] === "старый попап",
            JSON.stringify({ manifest: restored.files["manifest.json"], popup: restored.files["popup.js"] }));
          check("«Вернуть» снимает журнал и прячет кнопки",
            restored.intent === null && restored.restoreHidden === true && restored.resumeHidden === true,
            JSON.stringify({ intent: restored.intent, restore: restored.restoreHidden }));
          check("«Вернуть» называет возвращённую версию", /возвращена версия 2\.2\.0/i.test(restored.status), restored.status);
      } catch (e) {
        check("выбор папки не роняет набор", false, String((e && e.message) || e));
      }
    }

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
            for (let i = 0; i < 100; i++) {
              const state = await ev(`document.documentElement && document.documentElement.getAttribute('data-dzr-images')`);
              if (o.stop) {
                if (state === "running" && (await ev(`!document.getElementById('stop').hidden`))) break;
                if (state === "blocked" || state === "done") break;
              } else if (o.title) {
                if (state === "done" || state === "blocked") break;
              } else if (state === "ready" || state === "blocked") break;
              await sleep(100);
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
              var files = Object.keys(p.root.__files).filter(function (k) { return k.indexOf('news/') === 0; });
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

        // Порядок скачивания зависит от того, чей воркер закончил первым, поэтому
        // проверяем состав и последовательность номеров, а не конкретную раскладку
        // расширений по номерам.
        const extOf = (p) => (p.split(".").pop() || "").toLowerCase();
        const happy = await imagesCase({ title: "Новая модель Subaru", count: 5, seed: true });
        console.log("подбор: счастливый путь: %j", { status: happy.status, files: happy.files });
        const namesOk = happy.files.length === 5 &&
          happy.files.every((p) => /^news\/Новая модель Subaru\/0[1-5]\.(jpg|png|webp|gif)$/.test(p));
        const extList = happy.files.map(extOf).sort().join(",");
        check("окно скачало пять фото в news/<заголовок>",
          namesOk && extList === "gif,jpg,jpg,png,webp",
          JSON.stringify({ files: happy.files, ext: extList }));
        check("тяжёлая картинка и HTML вместо фото отброшены",
          happy.files.every((p) => !/heavy|notimage/.test(p)) && happy.files.length === 5,
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

        const noHandle = await imagesCase({});
        check("без рукояти предложен выбор папки", noHandle.chooseHidden === false, JSON.stringify(noHandle));

        const chosen = await imagesCase({
          after: `(async () => { document.getElementById('choose-dir').click(); await new Promise((r) => setTimeout(r, 400)); })()`
        });
        check("выбранная папка сохранена в IndexedDB",
          chosen.saved === true && chosen.sameHandle === true && chosen.picker === "readwrite",
          JSON.stringify({ saved: chosen.saved, same: chosen.sameHandle, picker: chosen.picker }));

        const evil = await imagesCase({ title: "../../evil", count: 5, seed: true });
        check("имя папки очищено: ни одного «..», всё внутри news/",
          evil.files.length > 0 && evil.files.every((p) => p.indexOf("news/evil/") === 0 && p.indexOf("..") < 0),
          JSON.stringify(evil.files));

        const clampLow = await imagesCase({ count: 4, seed: true });
        const clampHigh = await imagesCase({ count: 99, seed: true });
        check("настройка 4 читается как 5", /Сколько фото: 5/.test(clampLow.count), clampLow.count);
        check("настройка 99 ограничена 10", /Сколько фото: 10/.test(clampHigh.count), clampHigh.count);

        const settingsCase = await imagesCase({
          seed: true,
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

    const synonymValue = "polo = народный седан\nLand Cruiser = Крузак";
    const synonymSave = await evalJs(`(async () => {
      const field = document.getElementById('linkSynonyms');
      if (!field) return { exists: false };
      field.value = ${JSON.stringify(synonymValue)};
      document.getElementById('save').click();
      for (let i = 0; i < 30; i++) {
        const stored = await chrome.storage.local.get('linkSynonyms');
        if (stored.linkSynonyms === field.value) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const local = await chrome.storage.local.get('linkSynonyms');
      const sync = await chrome.storage.sync.get('linkSynonyms');
      return { exists: true, tag: field.tagName, local: local.linkSynonyms, inSync: sync.linkSynonyms !== undefined };
    })()`);
    check("синонимы: редактируемое поле сохраняет строки в local",
      synonymSave.exists && synonymSave.tag === 'TEXTAREA' && synonymSave.local === synonymValue && !synonymSave.inSync,
      JSON.stringify(synonymSave));
    await evalJs(`document.documentElement.removeAttribute('data-dzr-popup')`);
    await c.send('Page.reload', {}, sessionId);
    for (let i = 0; i < 40; i++) {
      // Сразу после reload документ ещё не построен: documentElement бывает null,
      // и голый getAttribute ронял весь набор. Ждём, пока он появится.
      if (await evalJs(`document.documentElement?.getAttribute('data-dzr-popup') === 'ready'`)) break;
      await sleep(150);
    }
    const synonymLoaded = await evalJs(`document.getElementById('linkSynonyms')?.value`);
    check("синонимы: после открытия попапа текст восстановлен", synonymLoaded === synonymValue);
    await evalJs(`document.getElementById('tab-settings').click()`);
    if (synonymSave.exists) {
      await evalJs(`document.getElementById('linkSynonyms').scrollIntoView({ block: 'center' })`);
      const shotSynonyms = await c.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(path.join(TMP, 'shot-synonyms.png'), Buffer.from(shotSynonyms.data, 'base64'));
    }
    const synonymCleared = await evalJs(`(async () => {
      const field = document.getElementById('linkSynonyms');
      if (!field) return false;
      field.value = '';
      document.getElementById('save').click();
      for (let i = 0; i < 30; i++) {
        const local = await chrome.storage.local.get('linkSynonyms');
        if (local.linkSynonyms === '') return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })()`);
    check("синонимы: пустое поле удаляет пользовательские правила", synonymCleared);

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
    process.exitCode = bad.length ? 1 : 0;
  } finally {
    try { execSync("taskkill /F /T /PID " + chrome.pid, { stdio: "ignore" }); } catch {}
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e.message || e); process.exit(1); });
