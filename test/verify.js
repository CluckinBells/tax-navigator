// Проверка движка на эталонных значениях из исходного Excel.
// Если все тесты зелёные — логика перенесена верно.

import { calculateAll, insuranceContributions, getTaxCalendar, nextDeadline } from '../shared/engine.js';
import { buildUsnIncomeDeclaration } from '../shared/declaration.js';
import { reminderStage, dueReminders, daysLeftPhrase, formatDateRu } from '../shared/reminders.js';

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}: получено ${actual}, ожидалось ${expected}`); }
}

console.log('Взносы:');
check('взносы при 5 млн', insuranceContributions(5000000), 104390);
check('взносы при 15 млн', insuranceContributions(15000000), 204390);
check('взносы при 30 млн', insuranceContributions(30000000), 354390);
check('взносы при 100 млн (кап)', insuranceContributions(100000000), 379208);

// --- Эталон 1: лист «Сравнение», параметры по умолчанию ---
// Выручка 5 млн, расходы 2 млн, физлица 30%, 0 работников, АУСН Да, ПСН Да, патент 30 000
console.log('\nЭталон 1 — выручка 5 млн (лист «Сравнение»):');
const r1 = calculateAll({
  revenue: 5000000, expenses: 2000000, individualsShare: 0.3,
  employees: 0, ausnRegion: true, patentAvailable: true, patentCost: 30000,
});
const by1 = Object.fromEntries(r1.regimes.map((r) => [r.id, r]));
check('НПД недоступен', by1.npd.available, false);
check('УСН6 итого', by1.usn6.total, 300000);
check('УСН15 итого', by1.usn15.total, 554390);
check('ПСН итого', by1.psn.total, 104390);
check('АУСН8 итого', by1.ausn8.total, 400000);
check('АУСН20 итого', by1.ausn20.total, 600000);
check('лучший режим — ПСН', r1.best.id, 'psn');
check('экономия vs худший', r1.savings, 495610);

// --- Эталон 2: лист «Сценарии», сценарий 2 ---
// Выручка 15 млн, расходы 6 млн, физлица 20%, 2 работника, АУСН Да, ПСН Да, патент 80 000
console.log('\nЭталон 2 — выручка 15 млн (сценарий 2):');
const r2 = calculateAll({
  revenue: 15000000, expenses: 6000000, individualsShare: 0.2,
  employees: 2, ausnRegion: true, patentAvailable: true, patentCost: 80000,
});
const by2 = Object.fromEntries(r2.regimes.map((r) => [r.id, r]));
check('УСН6 итого', by2.usn6.total, 900000);
check('ПСН итого', by2.psn.total, 244390);
check('АУСН8 итого', by2.ausn8.total, 1200000);
check('лучший режим — ПСН', r2.best.id, 'psn');

// --- Эталон 3: лист «Сценарии», сценарий 3 (с НДС) ---
// Выручка 30 млн, расходы 12 млн, физлица 10%, 5 работников, АУСН Да, ПСН Нет, патент 150 000
console.log('\nЭталон 3 — выручка 30 млн, ПСН недоступен (сценарий 3):');
const r3 = calculateAll({
  revenue: 30000000, expenses: 12000000, individualsShare: 0.1,
  employees: 5, ausnRegion: true, patentAvailable: false, patentCost: 150000,
});
const by3 = Object.fromEntries(r3.regimes.map((r) => [r.id, r]));
check('УСН6 итого (вкл. НДС 5%)', by3.usn6.total, 3300000);
check('ПСН недоступен', by3.psn.available, false);
check('АУСН8 итого', by3.ausn8.total, 2400000);
check('лучший режим — АУСН8', r3.best.id, 'ausn8');

// --- Эталон 4: лимит численности работников для ПСН (15 человек) ---
console.log('\nЭталон 4 — лимит ПСН по работникам (≤15):');
const psnInput = (employees) => calculateAll({
  revenue: 5000000, expenses: 2000000, individualsShare: 0.3,
  employees, ausnRegion: false, patentAvailable: true, patentCost: 30000,
});
const byPsn = (employees) => Object.fromEntries(psnInput(employees).regimes.map((r) => [r.id, r]));
check('ПСН доступен при 15 работниках', byPsn(15).psn.available, true);
check('ПСН недоступен при 16 работниках', byPsn(16).psn.available, false);
check('ПСН доступен при 0 работниках', byPsn(0).psn.available, true);

// --- Эталон 5: подсказки-причины недоступности ---
console.log('\nЭталон 5 — причины недоступности (подсказки):');
const reasonsFor = (id, inp) => Object.fromEntries(calculateAll(inp).regimes.map((r) => [r.id, r]))[id].reasons;
// НПД при выручке 5 млн -> причина про лимит
const npdHigh = reasonsFor('npd', { revenue: 5000000, expenses: 0, individualsShare: 0.3, employees: 0, ausnRegion: true, patentAvailable: true, patentCost: 30000 });
check('у НПД есть причина при 5 млн', npdHigh.length >= 1, true);
check('причина НПД упоминает лимит', npdHigh.some((s) => s.includes('лимит')), true);
// НПД при работнике -> причина про работников
const npdEmp = reasonsFor('npd', { revenue: 1000000, expenses: 0, individualsShare: 0.3, employees: 2, ausnRegion: true, patentAvailable: true, patentCost: 30000 });
check('причина НПД упоминает работников', npdEmp.some((s) => s.toLowerCase().includes('работник')), true);
// ПСН при 16 работниках
const psn16 = reasonsFor('psn', { revenue: 5000000, expenses: 0, individualsShare: 0.3, employees: 16, ausnRegion: false, patentAvailable: true, patentCost: 30000 });
check('причина ПСН про 15 работников', psn16.some((s) => s.includes('15')), true);
// Доступный режим -> причин нет
const psnOk = reasonsFor('psn', { revenue: 5000000, expenses: 0, individualsShare: 0.3, employees: 0, ausnRegion: false, patentAvailable: true, patentCost: 30000 });
check('у доступного ПСН нет причин', psnOk.length, 0);

// --- Эталон 6: налоговый календарь под режим ---
console.log('\nЭталон 6 — налоговый календарь:');
const fixedDay = new Date('2026-06-03T12:00:00Z'); // фиксируем «сегодня» для детерминизма
// УСН Доходы: должны быть авансы + взносы; ближайшее после 3 июня — аванс за полугодие (28 июля)
const usnCal = getTaxCalendar('usn6', fixedDay);
check('у УСН6 есть события календаря', usnCal.length > 0, true);
check('события отсортированы по дате', usnCal.every((e, i) => i === 0 || usnCal[i - 1].date <= e.date), true);
const usnNext = nextDeadline('usn6', fixedDay);
check('ближайшее УСН6 — не в прошлом', usnNext.isPast, false);
check('ближайшее УСН6 — 1 июля (1% взносов)', usnNext.date, '2026-07-01');
// ПСН: есть оплата патента
const psnCal = getTaxCalendar('psn', fixedDay);
check('у ПСН есть события (патент/взносы)', psnCal.some((e) => e.kind === 'Патент'), true);
// АУСН: только ежемесячный налог, без взносов ИП
const ausnCal = getTaxCalendar('ausn8', fixedDay);
check('у АУСН нет взносов ИП', ausnCal.every((e) => e.kind !== 'Взносы'), true);
// прошедшая дата помечается isPast
const pastCheck = getTaxCalendar('usn6', new Date('2026-12-31T12:00:00Z'));
check('31 декабря все даты пройдены', pastCheck.every((e) => e.isPast), true);

// --- Эталон 7: черновик декларации УСН «Доходы» (КНД 1152017) ---
console.log('\nЭталон 7 — декларация УСН Доходы:');
const decl = buildUsnIncomeDeclaration({
  incomeQ: [1250000, 1250000, 1250000, 1250000],
  contributionsQ: [0, 0, 0, 104390],
  employees: 0,
});
// Сверка с калькулятором на тех же годовых данных
const declCalc = calculateAll({ revenue: 5000000, expenses: 0, individualsShare: 0.3, employees: 0, ausnRegion: false, patentAvailable: false, patentCost: 0 });
const declUsn6 = declCalc.regimes.find((r) => r.id === 'usn6');
check('декларация: доход стр.113 = 5 млн', decl.section211.l113, 5000000);
check('декларация: налог стр.133 = 300000', decl.section211.l133, 300000);
check('декларация: вычет стр.143 = 104390', decl.section211.l143, 104390);
check('декларация: налог к уплате = калькулятор', decl.totals.taxToPayYear, declUsn6.tax);
check('декларация: аванс 1 кв стр.020 = 75000', decl.section11.l020, 75000);
// с работниками — вычет ограничен 50%
const declEmp = buildUsnIncomeDeclaration({ incomeQ: [1250000, 1250000, 1250000, 1250000], contributionsQ: [0, 0, 0, 300000], employees: 2 });
check('декларация с работниками: вычет = 50% (150000)', declEmp.section211.l143, 150000);

// --- Эталон 8: логика пуш-напоминаний о сроках ---
console.log('\nЭталон 8 — напоминания о сроках:');
// стадии по числу дней до срока (диапазоны дают «догоняющую» логику)
check('стадия за 7 дней', reminderStage(7), '7');
check('стадия за 5 дней (догон 7)', reminderStage(5), '7');
check('стадия за 3 дня', reminderStage(3), '3');
check('стадия за 2 дня (догон 3)', reminderStage(2), '3');
check('стадия за 1 день', reminderStage(1), '1');
check('стадия в день срока', reminderStage(0), '0');
check('за 8 дней — рано (null)', reminderStage(8), null);
check('срок прошёл — null', reminderStage(-1), null);

// За неделю до 1 июля (1% взносов) для УСН — должно появиться напоминание стадии '7'
const weekBefore = new Date('2026-06-24T10:00:00Z'); // ровно 7 дней до 2026-07-01
const due7 = dueReminders('usn6', weekBefore, {});
check('за 7 дней до 1 июля есть напоминание', due7.some((d) => d.date === '2026-07-01' && d.stage === '7'), true);
// уже отправленное напоминание не повторяется
const due7sent = dueReminders('usn6', weekBefore, { '2026-07-01:7': true });
check('отправленное напоминание не повторяется', due7sent.some((d) => d.date === '2026-07-01' && d.stage === '7'), false);
// далеко до срока (3 июня → ближайшее через 28 дней) — напоминаний нет
check('за 28 дней напоминаний нет', dueReminders('usn6', fixedDay, {}).length, 0);

// человеческие фразы и формат даты
check('фраза «сегодня»', daysLeftPhrase(0), 'сегодня');
check('фраза «завтра»', daysLeftPhrase(1), 'завтра');
check('фраза «через 2 дня»', daysLeftPhrase(2), 'через 2 дня');
check('фраза «через 5 дней»', daysLeftPhrase(5), 'через 5 дней');
check('формат даты «1 июл 2026»', formatDateRu('2026-07-01'), '1 июл 2026');

console.log(`\n${failed === 0 ? '✅' : '❌'} Итог: ${passed} прошло, ${failed} провалено`);
process.exit(failed === 0 ? 0 : 1);
