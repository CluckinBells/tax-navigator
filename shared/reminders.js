// Логика пуш-напоминаний о налоговых сроках (чистая, без UI и без сети).
// Используется ботом (bot/server.js) и тестами (test/verify.js).
// Дату «сейчас» всегда передаём снаружи — внутри Date.now() не вызываем,
// чтобы поведение было детерминированным и тестируемым.

import { getTaxCalendar } from './engine.js';

// За сколько дней до срока напоминаем. Стадии нужны, чтобы не слать по одному
// сообщению каждый день: один раз «за неделю», один — «за 3 дня», один — «за день»,
// и один — «в день срока». Ключ дедупликации = `${дата}:${стадия}`.
export const REMINDER_STAGES = [7, 3, 1, 0];

// По числу дней до срока возвращает стадию напоминания (строкой) или null,
// если напоминать ещё рано (>7 дней) или срок уже прошёл (<0).
// Диапазоны дают «догоняющую» логику: если тик пропустил ровно 7-й день,
// напоминание всё равно уйдёт на 6/5/4-й день (та же стадия '7').
export function reminderStage(daysLeft) {
  if (daysLeft == null || daysLeft < 0) return null;
  if (daysLeft === 0) return '0';
  if (daysLeft === 1) return '1';
  if (daysLeft <= 3) return '3';
  if (daysLeft <= 7) return '7';
  return null;
}

// Какие напоминания пора отправить для режима на момент `now`,
// с учётом уже отправленных (sentMap — объект { 'ГГГГ-ММ-ДД:стадия': true }).
// Возвращает массив событий с добавленными полями stage и key.
export function dueReminders(regimeId, now, sentMap = {}, calendar) {
  const events = getTaxCalendar(regimeId, now, calendar); // отсортированы, с daysLeft/isPast
  const out = [];
  for (const e of events) {
    if (e.isPast) continue;
    const stage = reminderStage(e.daysLeft);
    if (!stage) continue;
    const key = `${e.date}:${stage}`;
    if (sentMap[key]) continue;
    out.push({ ...e, stage, key });
  }
  return out;
}

// Русское склонение слова «день» для числа n (1 день, 2 дня, 5 дней).
function pluralDays(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'дней';
  if (b === 1) return 'день';
  if (b >= 2 && b <= 4) return 'дня';
  return 'дней';
}

// Человеческая фраза по числу дней до срока: сегодня / завтра / через N дней.
export function daysLeftPhrase(daysLeft) {
  if (daysLeft === 0) return 'сегодня';
  if (daysLeft === 1) return 'завтра';
  return `через ${daysLeft} ${pluralDays(daysLeft)}`;
}

const RU_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// Форматирует дату 'ГГГГ-ММ-ДД' как «1 июл 2026».
export function formatDateRu(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${RU_MONTHS[m - 1]} ${y}`;
}
