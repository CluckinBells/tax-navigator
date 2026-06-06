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
import { formatMoney } from './format.js';

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

// HTML-документ ЧЕРНОВИКА декларации УСН «Доходы» для печати / сохранения в PDF.
// Чистая функция: вход — declInput {incomeQ[4], contributionsQ[4], employees, rate?},
// выход — самодостаточный HTML. Используется webapp/print.html (открывается в браузере).
export function buildDeclarationHtml(declInput) {
  const d = buildUsnIncomeDeclaration(declInput);
  const s21 = d.section211, s11 = d.section11;
  const today = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const m = (v) => formatMoney(v);

  const line = (code, name, val) => `<tr><td class="c">${code}</td><td>${name}</td><td class="v">${m(val)}</td></tr>`;

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Черновик декларации УСН — ${today}</title>
  <style>
    *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f1120;margin:0}
    .page{max-width:780px;margin:0 auto;padding:38px 44px}
    .warn{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;font-size:12.5px;color:#92400e;margin-bottom:22px}
    h1{font-size:20px;margin:0 0 2px} .sub{color:#6b7090;font-size:13px;margin-bottom:8px}
    .knd{font-size:12px;color:#9095ad;margin-bottom:22px}
    h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#6b7090;margin:24px 0 8px;border-bottom:2px solid #ece9fb;padding-bottom:6px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    td{padding:8px 8px;border-bottom:1px solid #ececf4} td.c{width:64px;color:#9095ad;font-weight:700} td.v{text-align:right;font-weight:700;white-space:nowrap}
    .params{background:#f7f8fc;border-radius:10px;padding:14px 18px;margin-bottom:8px;font-size:13px}
    .params div{display:flex;justify-content:space-between;padding:2px 0} .params span{color:#6b7090}
    .total{background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;border-radius:12px;padding:16px 20px;margin-top:20px}
    .total .t{font-size:24px;font-weight:800}
    .foot{margin-top:26px;padding-top:14px;border-top:1px solid #ececf4;font-size:10.5px;color:#9095ad;line-height:1.6}
  </style></head><body><div class="page">
    <div class="warn">⚠️ Это <b>черновик для самопроверки</b>, а не готовая к подаче декларация. Перед сдачей сверьте данные и заполните официальную форму в Личном кабинете ФНС или у бухгалтера.</div>
    <h1>Декларация по УСН «Доходы» — черновик</h1>
    <div class="sub">Объект налогообложения: Доходы · ставка ${s21.l120}%${d.meta.hasEmployees ? ' · с работниками' : ' · без работников'}</div>
    <div class="knd">Форма по КНД 1152017 (${d.meta.form}) · подготовлено ${today}</div>

    <div class="params">
      <div><span>Доход за год</span><b>${m(d.totals.incomeYear)}</b></div>
      <div><span>Страховые взносы за год</span><b>${m(d.totals.contributionsYear)}</b></div>
    </div>

    <h2>Раздел 2.1.1 — расчёт налога</h2>
    <table>
      ${line('110', 'Доходы за I квартал', s21.l110)}
      ${line('111', 'Доходы за полугодие', s21.l111)}
      ${line('112', 'Доходы за 9 месяцев', s21.l112)}
      ${line('113', 'Доходы за год', s21.l113)}
      <tr><td class="c">120–123</td><td>Ставка налога</td><td class="v">${s21.l120}%</td></tr>
      ${line('130', 'Исчислено налога за I квартал', s21.l130)}
      ${line('131', 'Исчислено за полугодие', s21.l131)}
      ${line('132', 'Исчислено за 9 месяцев', s21.l132)}
      ${line('133', 'Исчислено за год', s21.l133)}
      ${line('140', 'Вычет взносов за I квартал', s21.l140)}
      ${line('141', 'Вычет за полугодие', s21.l141)}
      ${line('142', 'Вычет за 9 месяцев', s21.l142)}
      ${line('143', 'Вычет за год', s21.l143)}
    </table>

    <h2>Раздел 1.1 — налог к уплате</h2>
    <table>
      ${line('020', 'Аванс к уплате за I квартал', s11.l020)}
      ${line('040', 'Аванс к уплате за полугодие', s11.l040)}
      ${s11.l050 ? line('050', 'К уменьшению за полугодие', s11.l050) : ''}
      ${line('070', 'Аванс к уплате за 9 месяцев', s11.l070)}
      ${s11.l080 ? line('080', 'К уменьшению за 9 месяцев', s11.l080) : ''}
      ${line('100', 'Налог к доплате за год', s11.l100)}
      ${s11.l110 ? line('110', 'Налог к уменьшению за год', s11.l110) : ''}
    </table>

    <div class="total"><div>Итого налог УСН к уплате за год</div><div class="t">${m(d.totals.taxToPayYear)}</div></div>

    <div class="foot">Черновик сформирован сервисом «Налоговый навигатор ИП 2026» и носит справочный характер.
    Не является поданной декларацией и не заменяет официальную отчётность. Проверьте суммы и реквизиты (ИНН, ОКТМО, код ИФНС)
    перед подачей. Основано на форме КНД 1152017 (${d.meta.form}).</div>
  </div></body></html>`;
}
