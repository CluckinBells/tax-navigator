// Офлайн-проверка кодов доступа Pro (без сервера).
// Код = TN26-XXXXX-YYYYY, где первая группа — случайный «сериал»,
// вторая — контрольная подпись от сериала на секретном ключе.
// Подделать код нельзя, не зная SECRET. Проверка работает прямо в браузере.
//
// ВАЖНО: SECRET вшит в код мини-аппа, поэтому это «лёгкая» защита —
// она останавливает случайный подбор и перепродажу «угаданных» кодов,
// но технически продвинутый человек может извлечь SECRET из JS.
// Для старта и обкатки этого достаточно. На Этапе 2 (свой сервер)
// проверку можно перенести на бэкенд и сделать по-настоящему стойкой.

// Секрет проекта. Поменяйте на свой перед продажей кодов (любая длинная строка).
// Менять = аннулировать ВСЕ ранее выданные коды, поэтому делайте это до старта продаж.
export const CODES_SECRET = 'tax-navigator-2026-CHANGE-ME-7f3a9c2e';

// Алфавит без похожих символов (0/O, 1/I) — чтобы коды легко диктовать.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// Простой детерминированный хеш (FNV-1a → расширяем до нужной длины через смешивание).
// Криптостойкость не нужна: задача — чтобы без SECRET нельзя было собрать валидную пару.
function hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x1505;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = (h1 * 0x01000193) >>> 0;
    h2 = ((h2 << 5) + h2 + c) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function toBase32(hex, len) {
  // Берём hex-строку, превращаем в группы по символам ALPHABET.
  let out = '';
  for (let i = 0; i < len; i++) {
    const chunk = parseInt(hex.substr((i * 3) % (hex.length - 2), 3), 16) || 0;
    out += ALPHABET[chunk % ALPHABET.length];
  }
  return out;
}

const PREFIX = 'TN26'; // год привязки (TN26 = доступ на сезон 2026)

/** Подпись для конкретного «сериала». */
function sign(serial, secret = CODES_SECRET) {
  return toBase32(hash(PREFIX + '|' + serial + '|' + secret), 5);
}

/** Генерация одного кода из «сериала» (5 символов). */
export function makeCode(serial, secret = CODES_SECRET) {
  const s = serial.toUpperCase();
  return `${PREFIX}-${s}-${sign(s, secret)}`;
}

/**
 * Проверка кода. Возвращает { valid, prefix, serial } или { valid:false }.
 * Нормализует регистр и пробелы/дефисы, чтобы пользователь мог вводить как удобно.
 */
export function validateCode(raw, secret = CODES_SECRET) {
  if (!raw) return { valid: false };
  const cleaned = String(raw).toUpperCase().replace(/\s+/g, '').replace(/[—–]/g, '-');
  const m = cleaned.match(/^([A-Z0-9]{4})-([A-Z0-9]{5})-([A-Z0-9]{5})$/);
  if (!m) return { valid: false };
  const [, prefix, serial, sig] = m;
  if (prefix !== PREFIX) return { valid: false };
  if (sign(serial, secret) !== sig) return { valid: false };
  return { valid: true, prefix, serial };
}
