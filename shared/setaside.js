// «Налоговая подушка»: сколько отложить на налоги с дохода, заработанного с начала года.
// Чистая логика — использует движок (calculateAll) и легко тестируется отдельно.
// Идея: ввёл доход с начала года → видишь полную налоговую нагрузку (налог + взносы + НДС),
// которую стоит держать отложенной, чтобы хватило к срокам уплаты.

import { calculateAll } from './engine.js';

// Подсказки по режиму: когда и как платить (берутся в UI под выбранный режим).
export const SETASIDE_NOTES = {
  usn6: 'Авансы по УСН — до 28 апреля, 28 июля и 28 октября; итоговый налог — до 28 апреля следующего года. Взносы за себя: фиксированные — до 28 декабря, 1% с дохода свыше 300 000 ₽ — до 1 июля следующего года.',
  usn15: 'Авансы по УСН — до 28 апреля, 28 июля и 28 октября; итог — до 28 апреля следующего года. Если налог меньше 1% от дохода, платится минимальный налог 1%. Взносы за себя — как на УСН «Доходы».',
  psn: 'Патент оплачивается частями: 1/3 в начале срока, 2/3 — к концу. Отдельно платятся страховые взносы за себя (на них уменьшается стоимость патента).',
  npd: 'Налог НПД начисляет ФНС ежемесячно, оплата — до 28-го числа следующего месяца в приложении «Мой налог». Откладывайте 4–6% с каждого поступления.',
  ausn8: 'На АУСН налог считает банк ежемесячно и списывает автоматически — отдельно копить не нужно. Страховые взносы за себя не платятся.',
  ausn20: 'На АУСН налог считает банк ежемесячно и списывает автоматически. Минимальный налог — 3% от дохода. Страховые взносы за себя не платятся.',
};

// Режимы, где налог списывается автоматически — отдельно копить не нужно.
const AUTO_REGIMES = new Set(['ausn8', 'ausn20']);

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// input: { regimeId, incomeToDate, expensesToDate, paid, individualsShare, employees,
//          ausnRegion, patentAvailable, patentCost }
// Возвращает финансовую картину «сколько отложить» для выбранного режима.
export function computeSetAside(input, p) {
  const regimeId = input.regimeId;
  const paid = Math.max(0, num(input.paid));
  // Считаем нагрузку режима на доход, заработанный с начала года.
  const res = calculateAll({
    revenue: num(input.incomeToDate),
    expenses: num(input.expensesToDate),
    individualsShare: input.individualsShare != null ? input.individualsShare : 0.3,
    employees: input.employees != null ? input.employees : 0,
    ausnRegion: input.ausnRegion != null ? input.ausnRegion : true,
    patentAvailable: input.patentAvailable != null ? input.patentAvailable : true,
    patentCost: num(input.patentCost),
  }, p);

  const r = res.regimes.find((x) => x.id === regimeId) || null;
  const available = !!(r && r.available);
  const burden = available ? r.total : 0;        // полная нагрузка: налог + взносы + НДС
  const setAside = Math.max(0, burden - paid);    // сколько ещё держать отложенным

  return {
    regimeId,
    regimeName: r ? r.name : regimeId,
    available,
    auto: AUTO_REGIMES.has(regimeId),             // налог списывается автоматически (АУСН)
    burden,
    tax: r ? r.tax : 0,
    contributions: r ? r.contributions : 0,
    vat: r ? r.vat : 0,
    paid,
    setAside,
    effectiveRate: r && r.effectiveRate != null ? r.effectiveRate : null,
    note: SETASIDE_NOTES[regimeId] || '',
  };
}
