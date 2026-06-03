// Форматирование чисел для интерфейса (рубли, проценты).

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

export function formatMoney(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return rub.format(Math.round(value)) + ' ₽';
}

export function formatPercent(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  return (value * 100).toFixed(digits).replace('.', ',') + '%';
}

// «5 000 000» -> 5000000 ; принимает строки с пробелами/запятыми
export function parseMoney(str) {
  if (typeof str === 'number') return str;
  const n = parseFloat(String(str).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// Короткий формат для осей/чипов: 5 000 000 -> «5 млн»
export function formatShort(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return (value / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн';
  if (value >= 1_000) return Math.round(value / 1000) + ' тыс';
  return rub.format(value);
}
