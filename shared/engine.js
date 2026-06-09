// Движок расчёта налоговой нагрузки ИП на 2026 год.
// Чистая логика без UI — используется и лендингом, и Telegram Mini App.
// Перенесено из листов «Расчёт» / «Сравнение» исходного Excel и проверено
// на эталонных значениях (см. test/verify.js).

import { PARAMS_2026, TAX_CALENDAR_2026 } from './params.js';

/**
 * Страховые взносы ИП «за себя».
 * = фикс + 1% с дохода свыше порога, но не больше максимума.
 * Применяется к УСН (обоим) и ПСН. На НПД и АУСН взносы не платятся.
 */
export function insuranceContributions(revenue, p = PARAMS_2026) {
  const extra = Math.max(0, revenue - p.contributionThreshold) * p.contributionExtraRate;
  return Math.min(p.contributionMax, p.fixedContribution + extra);
}

/**
 * НДС для УСН по реформе 2026 (льготный путь без вычетов).
 * < 20 млн — освобождение; до 272.5 млн — 5%; выше — 7%.
 * Это упрощение: общий путь «22% с вычетами входящего НДС» здесь не считается.
 */
export function usnVat(revenue, p = PARAMS_2026) {
  if (revenue <= p.vatThreshold) return 0; // освобождение при доходе ≤ 20 млн (за предыдущий год)
  if (revenue <= p.vatMidThreshold) return revenue * p.vatLowRate;
  return revenue * p.vatHighRate;
}

const round = (x) => Math.round(x);

/** Вход:
 * {
 *   revenue: number,            // выручка за год, ₽
 *   expenses: number,           // документально подтверждённые расходы, ₽
 *   individualsShare: number,   // доля выручки от физлиц, 0..1 (для НПД)
 *   employees: number,          // кол-во наёмных работников
 *   ausnRegion: boolean,        // регион с АУСН?
 *   patentAvailable: boolean,   // доступен ли патент по виду деятельности?
 *   patentCost: number,         // стоимость патента в регионе, ₽
 * }
 */

// Красиво форматирует лимит в миллионах для подсказок: 2400000 -> «2,4 млн ₽».
function mln(n) {
  const v = n / 1_000_000;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',');
  return s + ' млн ₽';
}

function calcNPD(input, p) {
  const { revenue, individualsShare, employees } = input;
  const reasons = [];
  if (revenue > p.npdLimit) reasons.push(`Выручка выше лимита НПД — ${mln(p.npdLimit)} в год`);
  if (employees > 0) reasons.push('На НПД нельзя нанимать работников');
  const available = reasons.length === 0;
  const tax = available
    ? revenue * individualsShare * p.npdRateIndiv +
      revenue * (1 - individualsShare) * p.npdRateLegal
    : 0;
  return regime('npd', 'НПД (самозанятый)', available, {
    tax, contributions: 0, vat: 0, reasons,
    note: 'Лимит 2,4 млн ₽, без работников. 4% с физлиц, 6% с юрлиц.',
  });
}

function calcUsnIncome(input, p) {
  const { revenue, employees } = input;
  const reasons = [];
  if (revenue > p.usnLimit) reasons.push(`Выручка выше лимита УСН — ${mln(p.usnLimit)} в год`);
  const available = reasons.length === 0;
  const contributions = available ? insuranceContributions(revenue, p) : 0;
  const taxBefore = available ? revenue * p.usnIncomeRate : 0;
  // Вычет взносов: без работников — до 100% налога, с работниками — до 50%.
  const deduction = employees === 0
    ? Math.min(taxBefore, contributions)
    : Math.min(taxBefore * 0.5, contributions);
  const tax = taxBefore - deduction;
  const vat = available ? usnVat(revenue, p) : 0;
  return regime('usn6', 'УСН «Доходы» 6%', available, {
    tax, contributions, vat, reasons,
    note: 'Налог можно уменьшить на страховые взносы. НДС с выручки от 20 млн ₽.',
  });
}

function calcUsnProfit(input, p) {
  const { revenue, expenses } = input;
  const reasons = [];
  if (revenue > p.usnLimit) reasons.push(`Выручка выше лимита УСН — ${mln(p.usnLimit)} в год`);
  const available = reasons.length === 0;
  const contributions = available ? insuranceContributions(revenue, p) : 0;
  // Страховые взносы на УСН «Доходы-Расходы» — расходы, уменьшают налоговую базу (ст. 346.16 НК РФ).
  const base = Math.max(0, revenue - expenses - contributions);
  const taxRegular = base * p.usnProfitRate;
  const taxMin = revenue * p.usnMinTaxRate; // минимальный налог — 1% от выручки
  const tax = available ? Math.max(taxRegular, taxMin) : 0;
  const vat = available ? usnVat(revenue, p) : 0;
  return regime('usn15', 'УСН «Доходы-Расходы» 15%', available, {
    tax, contributions, vat, reasons,
    note: 'Выгоден при расходах > 60% выручки. Взносы за себя тоже идут в расходы. Минимальный налог — 1% от выручки.',
  });
}

function calcPSN(input, p) {
  const { revenue, employees, patentAvailable, patentCost } = input;
  // ПСН доступен при: есть патент по виду деятельности, выручка ≤ лимита
  // и средняя численность работников ≤ 15 человек (гл. 26.5 НК РФ).
  const reasons = [];
  if (!patentAvailable) reasons.push('Патент недоступен по вашему виду деятельности (отметьте «Патент: Да», если доступен)');
  if (revenue > p.psnLimit) reasons.push(`Выручка выше лимита ПСН — ${mln(p.psnLimit)} в год`);
  if (employees > p.psnMaxEmployees) reasons.push(`На ПСН не более ${p.psnMaxEmployees} работников`);
  const available = reasons.length === 0;
  const cost = available ? patentCost : 0;
  // На ПСН доп. взнос 1% считается от ПОТЕНЦИАЛЬНОГО дохода, а не от фактической выручки
  // (ст. 430 НК РФ). Потенциальный доход = стоимость патента / ставку ПСН (6%).
  const contributions = available ? insuranceContributions(cost / p.psnRate, p) : 0;
  // Стоимость патента уменьшается на взносы по тем же правилам, что и УСН Доходы.
  const deduction = employees === 0
    ? Math.min(cost, contributions)
    : Math.min(cost * 0.5, contributions);
  const tax = cost - deduction; // патент к уплате
  return regime('psn', 'ПСН (патент)', available, {
    tax, contributions, vat: 0, reasons,
    note: 'Фиксированная стоимость патента, уменьшается на взносы. Лимит 20 млн ₽ и до 15 работников.',
  });
}

function calcAusnIncome(input, p) {
  const { revenue, employees, ausnRegion } = input;
  const reasons = ausnReasons(input, p);
  const available = reasons.length === 0;
  const tax = available ? revenue * p.ausnIncomeRate : 0;
  return regime('ausn8', 'АУСН «Доходы» 8%', available, {
    tax, contributions: 0, vat: 0, reasons,
    note: 'Только в регионах эксперимента. Взносы не платятся. Лимит 60 млн ₽, ≤ 5 работников.',
  });
}

function calcAusnProfit(input, p) {
  const { revenue, expenses, employees, ausnRegion } = input;
  const reasons = ausnReasons(input, p);
  const available = reasons.length === 0;
  const base = Math.max(0, revenue - expenses);
  const taxRegular = base * p.ausnProfitRate;
  const taxMin = revenue * p.ausnMinTaxRate;
  const tax = available ? Math.max(taxRegular, taxMin) : 0;
  return regime('ausn20', 'АУСН «Доходы-Расходы» 20%', available, {
    tax, contributions: 0, vat: 0, reasons,
    note: 'Только в регионах эксперимента. Минимальный налог — 3% от выручки.',
  });
}

// Причины недоступности АУСН — общие для обоих объектов налогообложения.
function ausnReasons(input, p) {
  const { revenue, employees, ausnRegion } = input;
  const reasons = [];
  if (!ausnRegion) reasons.push('Ваш регион не участвует в эксперименте АУСН (отметьте «Регион с АУСН: Да», если участвует)');
  if (revenue > p.ausnLimit) reasons.push(`Выручка выше лимита АУСН — ${mln(p.ausnLimit)} в год`);
  if (employees > p.ausnMaxEmployees) reasons.push(`На АУСН не более ${p.ausnMaxEmployees} работников`);
  return reasons;
}

function regime(id, name, available, { tax, contributions, vat, note, reasons }) {
  const total = available ? tax + contributions + vat : 0;
  return {
    id, name, available, note,
    reasons: reasons || [],
    tax: round(tax),
    contributions: round(contributions),
    vat: round(vat),
    total: round(total),
  };
}

/**
 * Главная функция: считает все режимы, находит лучший и экономию.
 * Возвращает { regimes, best, worstAvailableTotal, savings, effectiveRate }.
 */
export function calculateAll(input, p = PARAMS_2026) {
  const normalized = {
    revenue: Math.max(0, num(input.revenue)),
    expenses: Math.max(0, num(input.expenses)),
    individualsShare: clamp01(num(input.individualsShare)),
    employees: Math.max(0, Math.floor(num(input.employees))),
    ausnRegion: !!input.ausnRegion,
    patentAvailable: !!input.patentAvailable,
    patentCost: Math.max(0, num(input.patentCost)),
  };

  const regimes = [
    calcNPD(normalized, p),
    calcUsnIncome(normalized, p),
    calcUsnProfit(normalized, p),
    calcPSN(normalized, p),
    calcAusnIncome(normalized, p),
    calcAusnProfit(normalized, p),
  ];

  // Эффективная ставка к выручке для каждого режима.
  for (const r of regimes) {
    r.effectiveRate = r.available && normalized.revenue > 0
      ? r.total / normalized.revenue
      : null;
  }

  const availableRegimes = regimes.filter((r) => r.available);
  let best = null;
  let savings = 0;
  let worstAvailableTotal = 0;

  if (availableRegimes.length > 0) {
    best = availableRegimes.reduce((a, b) => (b.total < a.total ? b : a));
    worstAvailableTotal = Math.max(...availableRegimes.map((r) => r.total));
    savings = worstAvailableTotal - best.total;
    for (const r of regimes) r.isBest = r === best;
  }

  return {
    input: normalized,
    regimes,
    best,
    worstAvailableTotal,
    savings: round(savings),
    effectiveRate: best && normalized.revenue > 0 ? best.total / normalized.revenue : null,
  };
}

/**
 * Точки перелома: при какой выручке меняется лучший режим.
 * Используется на Pro-экране «Сценарии». Расходы берутся как доля от выручки.
 */
export function breakevenSweep(baseInput, revenuePoints, p = PARAMS_2026) {
  const expenseShare = baseInput.expenseShare ?? 0.4;
  let prevBest = null;
  return revenuePoints.map((revenue) => {
    const res = calculateAll({
      ...baseInput,
      revenue,
      expenses: revenue * expenseShare,
    }, p);
    const bestId = res.best ? res.best.id : null;
    const changed = prevBest !== null && bestId !== prevBest;
    prevBest = bestId;
    return {
      revenue,
      best: res.best,
      minTotal: res.best ? res.best.total : null,
      effectiveRate: res.effectiveRate,
      isBreakpoint: changed,
    };
  });
}

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(/\s/g, '').replace(',', '.')) : v;
  return Number.isFinite(n) ? n : 0;
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Налоговый календарь под конкретный режим.
 * Возвращает события этого режима, отсортированные по дате, с числом дней до каждого.
 * @param {string} regimeId — id режима (npd/usn6/usn15/psn/ausn8/ausn20)
 * @param {Date|number} now — текущая дата (передаётся снаружи; в движке Date.now() не вызываем)
 * @param {Array} calendar — список событий (по умолчанию TAX_CALENDAR_2026)
 */
export function getTaxCalendar(regimeId, now, calendar = TAX_CALENDAR_2026) {
  const today = now instanceof Date ? now : new Date(now);
  // нормализуем «сегодня» к полуночи, чтобы дни считались по календарным суткам
  const t0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const MS_DAY = 24 * 60 * 60 * 1000;

  return calendar
    .filter((e) => e.regimes.includes(regimeId))
    .map((e) => {
      const [y, m, d] = e.date.split('-').map(Number);
      const due = Date.UTC(y, m - 1, d);
      const daysLeft = Math.round((due - t0) / MS_DAY);
      return { date: e.date, title: e.title, kind: e.kind, daysLeft, isPast: daysLeft < 0 };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Ближайшее предстоящее событие календаря (или null, если все прошли). */
export function nextDeadline(regimeId, now, calendar = TAX_CALENDAR_2026) {
  return getTaxCalendar(regimeId, now, calendar).find((e) => !e.isPast) || null;
}
