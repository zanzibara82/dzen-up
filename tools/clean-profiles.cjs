// Уборка временных папок, которые оставляют тесты.
//
//   node tools/clean-profiles.cjs            # удалить лишнее
//   node tools/clean-profiles.cjs --dry-run  # только показать
//
// Зачем. Раньше копии расширения и профили Chrome носили имена с pid и временем,
// поэтому каждый прогон создавал НОВЫЕ папки: за четыре дня набралось 756 копий
// (311 МБ) и 818 профилей (~26 ГБ). Имена сделали постоянными, прогон
// переиспользует те же папки — но накопленное надо было убрать, и убирать такое
// руками страшно: легко снести нужное.
//
// Список «нужного» здесь не выписан руками, а взят из самих наборов
// (`PATHS.testProfile("<tag>")`). Если набор переименуют, уборщик сам сочтёт
// старый профиль лишним — а если выписать имена в константу, она разъедется с
// тестами и уборщик начнёт удалять рабочие папки.
//
// Профилями пользуются не только наборы: `tools/live-rewrite-check.cjs` держит
// `liverw`, инструменты проверки Pixabay и прав — свои. Пока список собирался из
// одного `test/`, эти профили считались лишними и удалялись — уборщик сносил то,
// чем работают. Поэтому смотрим в оба каталога: имя берётся из того же
// `testProfile(…)`, просто лежит в другом файле.
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SCAN_DIRS = [path.join(ROOT, "test"), path.join(ROOT, "tools")];
const TMP = os.tmpdir();
const PREFIX = "dzr-";
const DRY = process.argv.includes("--dry-run");

const tags = new Set();
for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    // Себя не читаем: в этом файле есть и пример вызова, и шаблон поиска, и без
    // исключения уборщик находит «профиль» с именем `<tag>` — в списке нужного
    // появляется строка, которой нет ни у одного набора.
    if (!/\.cjs$/.test(f) || f === path.basename(__filename)) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/testProfile\("([^"]+)"\)/g)) tags.add(m[1]);
  }
}
if (tags.size === 0) throw new Error("не нашёл ни одного testProfile(…) в test/ и tools/ — уборщик устарел");

// Постоянные имена совпадают с именами профилей: и копии расширения
// (test-ext-<tag>), и профили (dzr-test-profile-<tag>) собираются из того же тега.
const keep = new Set([...tags].map((t) => "dzr-test-profile-" + t));

const all = fs.readdirSync(TMP).filter((n) => n.startsWith(PREFIX));
const legacy = all.filter((n) => !keep.has(n));

console.log("папка:               " + TMP);
console.log("всего dzr-папок:     " + all.length);
console.log("постоянных:          " + keep.size);
for (const n of [...keep].sort()) console.log("  оставляю  " + n);
console.log("лишних:              " + legacy.length);
for (const n of legacy.sort()) console.log("  удаляю    " + n);

if (DRY) {
  console.log("\n--dry-run: ничего не удалено");
  process.exit(0);
}

let done = 0;
let renamed = 0;
const failed = [];
for (const name of legacy) {
  const p = path.join(TMP, name);
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    done++;
    continue;
  } catch (e) {
    // Часть папок не удаляется под своим именем: каталог Default отвечает EPERM
    // и на запись, и на удаление, хотя ACL обычные и Chrome не запущен. Под
    // другим именем та же папка иногда удаляется — переименование заставляет
    // держателя дескриптора его отпустить. Помогает не всегда, но попытка дешёвая.
    const tmp = path.join(TMP, "dzr-trash-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
    try {
      fs.renameSync(p, tmp);
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      done++;
      renamed++;
    } catch (e2) {
      failed.push(name + ": " + e.code + " / после переименования: " + e2.code);
    }
  }
}

const left = fs.readdirSync(TMP).filter((n) => n.startsWith(PREFIX) && !keep.has(n));
console.log("\nудалено:             " + done + (renamed ? " (из них через переименование: " + renamed + ")" : ""));
console.log("осталось лишних:     " + left.length);
if (failed.length) {
  console.log("не удалось (" + failed.length + "):");
  for (const f of failed) console.log("  " + f);
  console.log("Такие папки держит что-то внешнее (не песочница и не Chrome): EPERM приходит и без");
  console.log("изоляции, а права при этом полные. Обычно их убирает перезагрузка или Проводник.");
}
