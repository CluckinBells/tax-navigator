// Формирование ЧЕРНОВИКА налоговой декларации по УСН «Доходы» (КНД 1152017).
// Форма по приказу ФНС от 26.12.2025 № ЕД-7-3/1017@ (за 2025, действует с 28.02.2026).
//
// ⚠️ Это ЧЕРНОВИК для самопроверки, НЕ замена официальной подачи.
// Считаем разделы 2.1.1 и 1.1 для объекта «доходы» нарастающим итогом по кварталам.
//
// Главный принцип (свод из методички ФНС):
//   стр.110-113 — доходы нарастающим итогом (I кв / полугодие / 9 мес / год)
//   стр.130-133 — исчисленный налог = доход × ставка
//   стр.140-143 — вычет взносов (без работников — до 100% налога, с работниками — до 50%)
//   Раздел 1.1 — авансы к уплате/уменьшению по периодам с зачётом предыдущих

import { PARAMS_2026 } from './params.js';

const round = (x) => Math.round(x);

/**
 * Вход: поквартальные суммы (НЕ нарастающим итогом — обычные суммы за квартал):
 * {
 *   incomeQ:        [q1, q2, q3, q4],   // доходы по кварталам, ₽
 *   contributionsQ: [q1, q2, q3, q4],   // страховые взносы, уплаченные в каждом квартале, ₽
 *   employees:      number,             // есть ли работники (влияет на лимит вычета 50%)
 *   rate:           number,             // ставка УСН Доходы (по умолчанию 0.06)
 * }
 * Возвращает объект со всеми строками разделов 2.1.1 и 1.1 + сверочные итоги.
 */
export function buildUsnIncomeDeclaration(input, p = PARAMS_2026) {
  const inc = (input.incomeQ || [0, 0, 0, 0]).map((v) => Math.max(0, num(v)));
  const con = (input.contributionsQ || [0, 0, 0, 0]).map((v) => Math.max(0, num(v)));
  const hasEmployees = Math.floor(num(input.employees)) > 0;
  const rate = num(input.rate) || p.usnIncomeRate;
  const ratePct = +(rate * 100).toFixed(1);

  // Нарастающий итог по периодам [I кв, полугодие, 9 мес, год].
  const cum = (arr) => arr.reduce((acc, v, i) => { acc.push((acc[i - 1] || 0) + v); return acc; }, []);
  const incomeCum = cum(inc);          // строки 110-113
  const contribCum = cum(con);

  // Исчисленный налог нарастающим итогом — строки 130-133.
  const taxCalc = incomeCum.map((d) => round(d * rate));

  // Вычет взносов нарастающим итогом — строки 140-143.
  // Без работников: до 100% налога. С работниками: не более 50% налога.
  const deduction = taxCalc.map((tax, i) => {
    const avail = contribCum[i];
    const cap = hasEmployees ? tax * 0.5 : tax;
    return round(Math.min(avail, cap));
  });

  // --- Раздел 1.1: авансы к уплате / уменьшению ---
  // По периодам считаем «налог нарастающим минус вычет», вычитаем ранее начисленное.
  const netCum = taxCalc.map((tax, i) => tax - deduction[i]); // налог к уплате нарастающим

  // Аванс I кв (стр.020)
  const adv1 = Math.max(0, netCum[0]);
  // Полугодие (стр.040 к доплате / 050 к уменьшению)
  const diff2 = netCum[1] - adv1;
  const adv2pay = Math.max(0, diff2), adv2red = Math.max(0, -diff2);
  // 9 мес (стр.070 / 080)
  const paidThrough2 = adv1 + adv2pay - adv2red;
  const diff3 = netCum[2] - paidThrough2;
  const adv3pay = Math.max(0, diff3), adv3red = Math.max(0, -diff3);
  // Год (стр.100 к доплате / 110 к уменьшению)
  const paidThrough3 = paidThrough2 + adv3pay - adv3red;
  const diff4 = netCum[3] - paidThrough3;
  const yearPay = Math.max(0, diff4), yearRed = Math.max(0, -diff4);

  // Итоговый налог за год к уплате (для сверки с калькулятором = налог-вычет за год).
  const totalTaxYear = netCum[3];

  return {
    meta: {
      knd: '1152017',
      form: 'Приказ ФНС от 26.12.2025 № ЕД-7-3/1017@',
      object: 'Доходы',
      ratePct,
      hasEmployees,
      isDraft: true,
    },
    // Раздел 2.1.1
    section211: {
      l110: incomeCum[0], l111: incomeCum[1], l112: incomeCum[2], l113: incomeCum[3],
      l120: ratePct, l121: ratePct, l122: ratePct, l123: ratePct,
      l130: taxCalc[0], l131: taxCalc[1], l132: taxCalc[2], l133: taxCalc[3],
      l140: deduction[0], l141: deduction[1], l142: deduction[2], l143: deduction[3],
    },
    // Раздел 1.1
    section11: {
      l020: round(adv1),
      l040: round(adv2pay), l050: round(adv2red),
      l070: round(adv3pay), l080: round(adv3red),
      l100: round(yearPay), l110: round(yearRed),
    },
    totals: {
      incomeYear: incomeCum[3],
      contributionsYear: contribCum[3],
      taxBeforeDeduction: taxCalc[3],
      deductionYear: deduction[3],
      taxToPayYear: round(totalTaxYear),  // сверяется с калькулятором (налог УСН после вычета)
    },
  };
}

function num(v) {
  const n = typeof v === 'string' ? parseFloat(String(v).replace(/\s/g, '').replace(',', '.')) : v;
  return Number.isFinite(n) ? n : 0;
}
