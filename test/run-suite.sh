#!/usr/bin/env bash
# Регрессия расширения "Дзен Рерайтер".
#
#   bash test/run-suite.sh                       # все 22 набора (~9 мин)
#   bash test/run-suite.sh --list                # напечатать имена наборов
#   bash test/run-suite.sh --only ui,popup       # только те наборы, в имени
#                                                # которых есть ui или popup
#   bash test/run-suite.sh --only links [путь]   # фильтр и путь-к-расширению
#
# Зачем --only. После правки обычно нужно проверить одно нововведение, а не всю
# регрессию: полный прогон — это десять минут на ровном месте. Но частичный
# прогон НЕ заменяет полный, поэтому в конце скрипт прямо говорит, что наборов
# было меньше, чем всего.
#
# По умолчанию проверяется СОБРАННАЯ папка (то, что грузится в Chrome),
# а не исходники — так тест ловит и ошибку сборки тоже.
# Переопределить можно аргументом или переменной DZR_EXT.
#
# Наборы запускаются СТРОГО последовательно: у каждого свой порт мок-сервера
# (8787–8799, из них 8794 занят набором забора) и свой Chrome. Пересечение портов ломает соседний набор.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"

# Важно: харнессам путь передаётся в Windows-виде. Git Bash отдаёт /c/Users/...,
# а Node на Windows такой путь не находит (видит его от корня диска).
winpath() { (cd "$1" && pwd -W 2>/dev/null) || (cd "$1" && pwd); }

# Имена наборов в том порядке, в котором они запускаются ниже. Список ведём
# отдельно от вызовов, чтобы посчитать, сколько наборов реально пойдёт: иначе
# при фильтре заголовки печатали бы «3/20», когда запущено три набора.
NAMES=(
  docs reliability links channels fetch
  format-mock4 format-mock5 format-mock6
  preview collapse glossary storage copy popup skiplang
  linkify strip signature ai-local ui source mocks
)

ONLY=""
LIST_ONLY=0
EXT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 ;;
    --list) LIST_ONLY=1; shift ;;
    --*) echo "Не знаю такого ключа: $1"
         echo "Есть: --only <шаблоны через запятую>, --list"
         exit 2 ;;
    *) EXT="$1"; shift ;;
  esac
done

if [ "$LIST_ONLY" -eq 1 ]; then
  echo "Наборы (${#NAMES[@]}):"
  for n in "${NAMES[@]}"; do echo "  $n"; done
  exit 0
fi

PATTERNS=()
if [ -n "$ONLY" ]; then
  IFS=',' read -r -a PATTERNS <<< "$ONLY"
fi

# Подходит ли набор под фильтр. Без --only подходит любой.
want() {
  [ "${#PATTERNS[@]}" -eq 0 ] && return 0
  local pat
  for pat in "${PATTERNS[@]}"; do
    [ -z "$pat" ] && continue
    case "$1" in *"$pat"*) return 0 ;; esac
  done
  return 1
}

TOTAL_SUITES=0
for n in "${NAMES[@]}"; do
  if want "$n"; then TOTAL_SUITES=$((TOTAL_SUITES + 1)); fi
done
if [ "$TOTAL_SUITES" -eq 0 ]; then
  echo "Ни один набор не подошёл под --only $ONLY"
  echo "Посмотреть имена: bash test/run-suite.sh --list"
  exit 2
fi

EXT="${EXT:-${DZR_EXT:-$(winpath "$REPO/..")/dzen-rewriter}}"
cd "$DIR" || exit 1

if [ ! -f "$EXT/manifest.json" ]; then
  echo "Не нахожу расширение: $EXT"
  echo "Соберите его: npm run ext:build   (или передайте путь первым аргументом)"
  exit 1
fi

TOTAL=0
FAILED=0
IDX=0

# Печатает "всего проверок: N, провалов: M" и накапливает итог.
run() {
  local name="$1"; local title="$2"; shift 2
  IDX=$((IDX + 1))
  echo ""
  echo "=== $IDX/$TOTAL_SUITES $title"
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  echo "$out" | grep -E "всего проверок|провал|FAIL|PASS|Готово|тост|vertical|закрылась" || true
  local t f
  t="$(echo "$out" | grep -oE "всего проверок: [0-9]+" | grep -oE "[0-9]+" | tail -1)"
  f="$(echo "$out" | grep -oE "провалов: [0-9]+" | grep -oE "[0-9]+" | tail -1)"
  if [ -n "${t:-}" ]; then TOTAL=$((TOTAL + t)); fi
  if [ -n "${f:-}" ]; then FAILED=$((FAILED + f)); fi
  # Ненулевой код возврата — тоже провал. Важно: смотрим код ИМЕННО харнесса,
  # поэтому он снят сразу после запуска. Раньше проверка стояла после `grep || true`
  # и всегда видела 0 — упавший харнесс молча считался «0 проверок, 0 провалов».
  if [ "$rc" -ne 0 ]; then
    FAILED=$((FAILED + 1))
    echo "  ⚠️  харнесс упал с кодом $rc — вывод выше"
    echo "$out" | tail -12 | sed 's/^/      /'
  fi
}

# Статическая проверка идёт первой: она не поднимает Chrome и падает за доли
# секунды — если README разошёлся с константами, незачем ждать десять минут.
want docs        && run docs        "README против кода"          node test-docs.cjs "$EXT"
want reliability && run reliability "юнит: надёжность перевода"   node test-reliability.cjs
want links       && run links       "юнит: перелинковка"          node test-links.cjs
want channels    && run channels    "юнит: карта канала Дзена"    node test-channels.cjs
want fetch       && run fetch       "юнит: забор текста по адресу" node test-fetch.cjs
want format-mock4 && run format-mock4 "mock4: формат A/B/C"        node test-format.cjs "$EXT" mock4.html
want format-mock5 && run format-mock5 "mock5: сложная структура"   node test-format.cjs "$EXT" mock5.html
want format-mock6 && run format-mock6 "mock6: отмена и прогресс"   node test-format.cjs "$EXT" mock6.html
want preview     && run preview     "предпросмотр"                node test-preview.cjs "$EXT"
want collapse    && run collapse    "свёртывание в пузырёк"       node test-collapse.cjs "$EXT"
want glossary    && run glossary    "глоссарий терминов"          node test-glossary.cjs "$EXT"
want storage     && run storage     "хранилище настроек"          node test-storage.cjs "$EXT"
want copy        && run copy        "клик по уведомлению"         node test-copy.cjs "$EXT"
want popup       && run popup       "попап расширения"            node test-popup.cjs "$EXT"
want skiplang    && run skiplang    "пропуск уже переведённого"   node test-skiplang.cjs "$EXT"
want linkify     && run linkify     "перелинковка в редакторе"    node test-linkify.cjs "$EXT"
want strip       && run strip       "чистка ссылок при переводе"  node test-strip.cjs "$EXT"
want signature   && run signature   "приписка в конце статьи"     node test-signature.cjs "$EXT"
want ai-local    && run ai-local    "своя модель (Ollama) в панели" node test-ai-local.cjs "$EXT"
want ui          && run ui          "панель: крестик и края"      node test-ui.cjs "$EXT"
want source      && run source      "забор текста со страницы"     node test-source.cjs "$EXT"
# Здесь проверок не печатает сам харнесс, поэтому считаем их тут: каждый мок
# обязан закончиться «✅ Готово». Иначе провал прошёл бы незамеченным.
want mocks       && run mocks       "моки выделения"              bash -c "
  ok=0; bad=0
  for p in mock.html mock2.html mock3.html; do
    t=\$(node test-ext2.cjs '$EXT' \$p 2>&1 | grep -E '^тост')
    echo \"--- \$p: \$t\"
    case \"\$t\" in *Готово*) ok=\$((ok+1));; *) bad=\$((bad+1));; esac
  done
  echo \"всего проверок: \$((ok+bad)), провалов: \$bad\"
"

echo ""
echo "==================================================="
echo "ИТОГО проверок: $TOTAL, провалов: $FAILED"
if [ "$TOTAL_SUITES" -lt "${#NAMES[@]}" ]; then
  echo "Частичный прогон: $TOTAL_SUITES наборов из ${#NAMES[@]}."
  echo "Это НЕ полная регрессия — перед сдачей нужен прогон без --only."
fi
echo "==================================================="
