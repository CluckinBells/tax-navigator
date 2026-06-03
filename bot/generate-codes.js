// Генератор кодов доступа Pro. Запуск:  node bot/generate-codes.js [сколько]
// Печатает список кодов — раздавайте/продавайте их покупателям.
// Каждый код одноразово помечайте использованным в своём списке (Excel/блокнот).

import { makeCode, validateCode } from '../shared/codes.js';

const count = Number(process.argv[2]) || 20;

// Случайный «сериал» из 5 символов алфавита кодов.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function randomSerial() {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

console.log(`\n=== ${count} кодов доступа Pro (сезон 2026) ===\n`);
const seen = new Set();
let printed = 0;
while (printed < count) {
  const serial = randomSerial();
  if (seen.has(serial)) continue;
  seen.add(serial);
  const code = makeCode(serial);
  // самопроверка
  if (!validateCode(code).valid) { console.error('ОШИБКА генерации:', code); continue; }
  console.log('  ' + code);
  printed++;
}
console.log(`\nГотово. Сохраните этот список — отмечайте использованные коды.`);
console.log(`Покупатель вводит код в мини-аппе: «У меня есть код» → Pro открывается.\n`);
