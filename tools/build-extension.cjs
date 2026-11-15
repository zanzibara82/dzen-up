#!/usr/bin/env node
/**
 * Собирает готовую к загрузке папку расширения и zip из src/extension-src.
 *
 *   node tools/build-extension.cjs [--out <папка>] [--out=<папка>] [--no-zip] [--force]
 *
 * По умолчанию кладёт результат рядом с репозиторием (..\dzen-rewriter) —
 * именно эту папку грузят в Chrome через «Загрузить распакованное расширение».
 * Переопределить: аргументом --out или переменной DZR_OUT. Существующую папку
 * с другим именем сборщик без --force не трогает: рядом с установкой легко
 * завести резервную копию, и стереть её из-за опечатки в --out нельзя.
 *
 * Зависимостей нет: zip пишется встроенным zlib, чтобы сборка работала
 * на голом Node без npm install.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const REPO = path.resolve(__dirname, "..");
const SRC = path.join(REPO, "src", "extension-src");

// Файлы, без которых расширение не работает. Иконки лежат в icons/.
// news в zip не попадает: zip собирается из этого списка, а папка news — данные
// пользователя, которые пересборка сохраняет, но не распространяет.
const FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "rewriter.js",
  "presets.js",
  "images.js",
  "images.html",
  "images-page.js",
  "content.css",
  "popup.html",
  "popup.js",
  "update.js",
  "README.md"
];
const ICONS = ["icons/icon16.png", "icons/icon48.png", "icons/icon128.png"];

// ------------------------------------------------------------------ zip ---

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Минимальный ZIP: только то, что нужно Chrome для распаковки. */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const packed = deflated.length < e.data.length ? deflated : e.data;
    const method = deflated.length < e.data.length ? 8 : 0; // 8 = deflate, 0 = store

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // нужная версия
    lh.writeUInt16LE(0x0800, 6); // имена в UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); // время
    lh.writeUInt16LE(0x21, 12); // дата: 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(packed.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, packed);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(packed.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 38); // внешние атрибуты
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + packed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([Buffer.concat(locals), centralBuf, end]);
}

// ----------------------------------------------------------------- main ---

function usage(msg) {
  console.error(msg + "\n\n  node tools/build-extension.cjs [--out <папка>] [--out=<папка>] [--no-zip] [--force]");
  process.exit(2);
}

function parseArgs(argv) {
  const out = { out: process.env.DZR_OUT || path.join(REPO, "..", "dzen-rewriter"), zip: true, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-zip") out.zip = false;
    else if (a === "--force") out.force = true;
    else if (a === "--out" || a.startsWith("--out=")) {
      const v = a === "--out" ? argv[++i] : a.slice("--out=".length);
      if (!v || (a === "--out" && v.startsWith("--"))) usage("--out ждёт путь к папке");
      out.out = v;
    } else {
      // Молча проглоченная опечатка оставляла путь по умолчанию — живую папку
      // установки, — и сборщик сносил её.
      usage("неизвестный аргумент: " + a);
    }
  }
  out.out = path.resolve(out.out);
  return out;
}

/** Файлы, на которые ссылается манифест: без них пакет не загрузится. */
function manifestRefs(manifest) {
  const refs = [];
  if (manifest.background && manifest.background.service_worker) refs.push(manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) refs.push(...(cs.js || []), ...(cs.css || []));
  if (manifest.action && manifest.action.default_popup) refs.push(manifest.action.default_popup);
  if (manifest.options_ui && manifest.options_ui.page) refs.push(manifest.options_ui.page);
  for (const p of Object.values(manifest.icons || {})) refs.push(p);
  for (const war of manifest.web_accessible_resources || []) {
    for (const r of war.resources || []) if (!r.includes("*")) refs.push(r);
  }
  return refs;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = FILES.concat(ICONS);

  // 1. проверяем исходники до того, как что-то менять на диске
  const missing = payload.filter((rel) => !fs.statSync(path.join(SRC, rel), { throwIfNoEntry: false })?.isFile());
  if (missing.length) {
    console.error("НЕТ ИСХОДНЫХ ФАЙЛОВ:");
    missing.forEach((m) => console.error("  " + path.join(SRC, m)));
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));

  const notShipped = manifestRefs(manifest).filter((rel) => payload.indexOf(rel) < 0);
  if (notShipped.length) {
    console.error("МАНИФЕСТ ССЫЛАЕТСЯ НА ФАЙЛЫ ВНЕ СПИСКА СБОРКИ:");
    notShipped.forEach((m) => console.error("  " + m));
    process.exit(1);
  }

  // 2. папка. Существующую папку с другим именем не трогаем без --force:
  // «dzen-rewriter-backup» и «dzen-rewriter (копия)» — тоже живые папки, и
  // стереть их из-за невнимательного --out нельзя.
  const base = path.basename(args.out);
  if (fs.existsSync(args.out) && base !== "dzen-rewriter" && !args.force) {
    console.error(
      "Отказываюсь перезаписывать «" + args.out + "»: имя папки не «dzen-rewriter».\n" +
        "Если это правда сборочная папка, повторите с --force."
    );
    process.exit(1);
  }

  // Сборка идёт в соседнюю временную папку и подменяет установку переименованием:
  // осечка посередине копирования не оставит смесь старого и нового кода.
  // Подобранные фотографии лежат внутри папки установки (news), поэтому они
  // переезжают в новую папку до того, как старая сойдёт с места.
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(args.out), "." + base + "-new-"));
  const oldPath = path.join(path.dirname(args.out), "." + base + "-old-" + process.pid);
  let newsMoved = false;
  try {
    for (const rel of payload) {
      const dst = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(SRC, rel), dst);
    }
    const NEWS = path.join(args.out, "news");
    if (fs.existsSync(NEWS)) {
      fs.renameSync(NEWS, path.join(staging, "news"));
      newsMoved = true;
    }
    if (fs.existsSync(args.out)) fs.renameSync(args.out, oldPath);
    fs.renameSync(staging, args.out);
  } catch (e) {
    try {
      if (!fs.existsSync(args.out) && fs.existsSync(oldPath)) fs.renameSync(oldPath, args.out);
      if (newsMoved && !fs.existsSync(path.join(args.out, "news"))) {
        fs.renameSync(path.join(staging, "news"), path.join(args.out, "news"));
      }
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (e2) {
      console.error("НЕ УДАЛОСЬ ВЕРНУТЬ СБОРОЧНЫЕ ФАЙЛЫ. Новая папка лежит здесь: " + staging);
    }
    throw e;
  }
  try {
    fs.rmSync(oldPath, { recursive: true, force: true });
  } catch (e) {
    console.error("Старая папка не удалилась, её можно стереть вручную: " + oldPath);
  }

  console.log("папка: " + args.out);
  for (const rel of payload) {
    const size = fs.statSync(path.join(args.out, rel)).size;
    console.log("  " + rel.padEnd(24) + String(size).padStart(7) + " байт");
  }

  // 3. zip
  if (args.zip) {
    const zipPath = path.join(path.dirname(args.out), `${path.basename(args.out)}-v${manifest.version}.zip`);
    const entries = payload.map((rel) => ({
      name: path.basename(args.out) + "/" + rel,
      data: fs.readFileSync(path.join(SRC, rel))
    }));
    const buf = makeZip(entries);
    fs.writeFileSync(zipPath, buf);
    console.log("zip:   " + zipPath + "  " + buf.length + " байт, файлов: " + entries.length);
  }

  console.log("\nЗагрузить в Chrome: chrome://extensions → Режим разработчика → Загрузить распакованное расширение → " + args.out);
}

main();
