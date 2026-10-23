#!/usr/bin/env node
/**
 * Собирает готовую к загрузке папку расширения и zip из src/extension-src.
 *
 *   node tools/build-extension.cjs [--out <папка>] [--no-zip]
 *
 * По умолчанию кладёт результат рядом с репозиторием (..\dzen-rewriter) —
 * именно эту папку грузят в Chrome через «Загрузить распакованное расширение».
 * Переопределить: аргументом --out или переменной DZR_OUT.
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
const FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "rewriter.js",
  "presets.js",
  "content.css",
  "popup.html",
  "popup.js",
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

function parseArgs(argv) {
  const out = { out: process.env.DZR_OUT || path.join(REPO, "..", "dzen-rewriter"), zip: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) out.out = path.resolve(argv[++i]);
    else if (argv[i] === "--no-zip") out.zip = false;
  }
  out.out = path.resolve(out.out);
  return out;
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

  // 2. папка. Страховка: сносим только то, что похоже на нашу выходную папку —
  // иначе опечатка в --out могла бы удалить что-то чужое.
  if (fs.existsSync(args.out) && !/^dzen-rewriter/.test(path.basename(args.out))) {
    console.error(
      "Отказываюсь перезаписывать «" + args.out + "»: имя папки не похоже на сборочную.\n" +
        "Ожидается папка с именем, начинающимся на «dzen-rewriter»."
    );
    process.exit(1);
  }

  fs.rmSync(args.out, { recursive: true, force: true });
  for (const rel of payload) {
    const dst = path.join(args.out, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(SRC, rel), dst);
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
