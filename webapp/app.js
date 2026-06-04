// Telegram Mini App — Налоговый навигатор ИП 2026.
// Использует общий движок расчёта (тот же, что и на лендинге).

import { calculateAll, breakevenSweep, getTaxCalendar } from '../shared/engine.js';
import { formatMoney, formatPercent, formatShort, parseMoney } from '../shared/format.js';
import { validateCode } from '../shared/codes.js';
import { buildUsnIncomeDeclaration } from '../shared/declaration.js';

const tg = window.Telegram?.WebApp;
const $ = (id) => document.getElementById(id);

// --- Подсказки к полям (для новичков) ---
// Тап по «?» показывает простое объяснение. В Telegram — нативный попап, иначе — alert.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.help');
  if (!btn) return;
  e.preventDefault();
  const text = btn.getAttribute('data-help') || '';
  tg?.HapticFeedback?.impactOccurred?.('light');
  if (tg?.showPopup) {
    tg.showPopup({ title: 'Подсказка', message: text, buttons: [{ type: 'ok' }] });
  } else if (tg?.showAlert) {
    tg.showAlert(text);
  } else {
    alert(text);
  }
});

// Адрес бэкенда (бота). Подставьте свой при деплое.
// Объявлен в начале файла, т.к. используется в verifyProWithBackend() при инициализации.
const BACKEND_URL = 'https://nalogovik-cluckin.waw0.amvera.tech';
// Адрес страницы политики конфиденциальности (тот же домен, где выложена статика).
const PRIVACY_URL = 'https://cluckinbells.github.io/tax-navigator/landing/privacy.html';

// --- Инициализация Telegram ---
let isPro = false;
if (tg) {
  tg.ready();
  tg.expand();
  // setHeaderColor поддерживается с Bot API 6.1 — на старых клиентах не вызываем (иначе варнинг).
  if (tg.isVersionAtLeast?.('6.1')) tg.setHeaderColor('secondary_bg_color');
  // Быстрый предварительный Pro-статус из ссылки запуска (мгновенно, до ответа сервера).
  isPro = detectProFromLaunch();
  // Достоверный Pro-статус — с бэкенда по подписи initData (см. bot/server.js).
  verifyProWithBackend();
}

// Бэкенд считается настроенным, только если адрес заменён с заглушки на реальный.
const BACKEND_READY = !BACKEND_URL.includes('example.com');

// Спрашиваем бэкенд, есть ли у пользователя Pro (надёжная проверка по подписи).
async function verifyProWithBackend() {
  if (!tg?.initData || !BACKEND_READY) return; // на Этапе 1 (без сервера) не дёргаем сеть
  try {
    const res = await fetch(`${BACKEND_URL}/me`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.isPro && !isPro) { isPro = true; applyProLock(); recalc(); }
  } catch (_) { /* бэкенд недоступен — остаёмся на предварительном статусе */ }
}

const PRO_CODE_KEY = 'tn_pro_code'; // сюда сохраняем активированный код доступа

function detectProFromLaunch() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('pro') === '1') return true;
    const sp = tg?.initDataUnsafe?.start_param;
    if (sp && sp.includes('pro')) return true;
    // Ранее активированный код доступа на этом устройстве.
    const saved = localStorage.getItem(PRO_CODE_KEY);
    if (saved && validateCode(saved).valid) return true;
  } catch (_) {}
  // Локальный режим разработки (вне Telegram) — для отладки можно открыть ?pro=1
  return false;
}

// --- Поля формы ---
const F = {
  revenue: $('revenue'),
  expenses: $('expenses'),
  individualsShare: $('individualsShare'),
  indivOut: $('indivOut'),
  employees: $('employees'),
  ausnRegion: $('ausnRegion'),
  patentAvailable: $('patentAvailable'),
  patentCost: $('patentCost'),
  patentCostField: $('patentCostField'),
};

function attachMoneyInput(input) {
  input.addEventListener('input', () => {
    const caretFromEnd = input.value.length - input.selectionStart;
    const n = parseMoney(input.value);
    input.value = n ? n.toLocaleString('ru-RU') : '';
    const pos = Math.max(0, input.value.length - caretFromEnd);
    input.setSelectionRange?.(pos, pos);
    recalc();
  });
}
['revenue', 'expenses', 'patentCost'].forEach((k) => attachMoneyInput(F[k]));

F.individualsShare.addEventListener('input', () => {
  F.indivOut.textContent = F.individualsShare.value + '%';
  recalc();
});
F.employees.addEventListener('input', recalc);

// Чипы-переключатели Да/Нет
[F.ausnRegion, F.patentAvailable].forEach((chip) => {
  chip.addEventListener('click', () => {
    const on = chip.dataset.on === 'true';
    chip.dataset.on = String(!on);
    chip.querySelector('span').textContent = on ? 'Нет' : 'Да';
    tg?.HapticFeedback?.selectionChanged?.();
    if (chip === F.patentAvailable) {
      F.patentCostField.style.display = on ? 'none' : '';
    }
    recalc();
  });
});

function readInput() {
  return {
    revenue: parseMoney(F.revenue.value),
    expenses: parseMoney(F.expenses.value),
    individualsShare: Number(F.individualsShare.value) / 100,
    employees: Number(F.employees.value) || 0,
    ausnRegion: F.ausnRegion.dataset.on === 'true',
    patentAvailable: F.patentAvailable.dataset.on === 'true',
    patentCost: parseMoney(F.patentCost.value),
  };
}

// Сохранение введённых данных на устройстве. НЕ отправляется на сервер —
// остаётся в локальном хранилище приложения (усиливает приватность, а не нарушает её).
const STORAGE_KEY = 'tn_webapp_inputs';

function saveInputs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      revenue: F.revenue.value,
      expenses: F.expenses.value,
      individualsShare: F.individualsShare.value,
      employees: F.employees.value,
      ausnRegion: F.ausnRegion.dataset.on,
      patentAvailable: F.patentAvailable.dataset.on,
      patentCost: F.patentCost.value,
    }));
  } catch (_) {}
}

function restoreInputs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.revenue != null) F.revenue.value = s.revenue;
    if (s.expenses != null) F.expenses.value = s.expenses;
    if (s.individualsShare != null) { F.individualsShare.value = s.individualsShare; F.indivOut.textContent = s.individualsShare + '%'; }
    if (s.employees != null) F.employees.value = s.employees;
    // Восстанавливаем чипы Да/Нет с корректной подписью.
    [['ausnRegion', s.ausnRegion], ['patentAvailable', s.patentAvailable]].forEach(([id, val]) => {
      if (val == null) return;
      const chip = F[id];
      chip.dataset.on = String(val);
      chip.querySelector('span').textContent = (val === 'true' || val === true) ? 'Да' : 'Нет';
    });
    if (F.patentAvailable.dataset.on === 'false') F.patentCostField.style.display = 'none';
    if (s.patentCost != null) F.patentCost.value = s.patentCost;
  } catch (_) {}
}

// --- Основной пересчёт ---
let lastResult = null;
let lastInput = null;

function recalc() {
  const input = readInput();
  const res = calculateAll(input);
  lastResult = res;
  lastInput = input;

  // Предупреждение, если расходы больше выручки.
  const warn = $('expenseWarn');
  if (warn) warn.hidden = !(input.expenses > input.revenue && input.revenue > 0);

  // Сохраняем данные на устройстве для следующего запуска.
  saveInputs();

  renderBest(res);
  renderCompare(res);
  if (isPro) {
    renderVerdict(res, input);
    renderDetail(res);
    renderScenarios(input);
    renderCalendar(res);
    renderDeclaration(res, input);
  }
}

function renderBest(res) {
  if (res.best) {
    $('bestName').textContent = res.best.name;
    $('bestTotal').textContent = formatMoney(res.best.total);
    if (res.savings > 0) {
      $('bestSave').style.display = '';
      $('bestSave').textContent = `Экономия ${formatMoney(res.savings)} в год`;
    } else {
      $('bestSave').style.display = 'none';
    }
  } else {
    $('bestName').textContent = 'Нет доступных режимов';
    $('bestTotal').textContent = '—';
    $('bestSave').style.display = 'none';
  }
}

function renderCompare(res) {
  const sorted = [...res.regimes].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.total - b.total;
  });
  const maxTotal = Math.max(1, ...res.regimes.filter((r) => r.available).map((r) => r.total));

  $('compareList').innerHTML = sorted.map((r) => {
    if (!r.available) {
      const why = (r.reasons && r.reasons.length) ? r.reasons.join(' • ') : 'Недоступен при ваших параметрах';
      return `<div class="crow crow--off" tabindex="0">
        <span class="crow__name">${r.name}</span>
        <span class="crow__na">недоступен <span class="crow__why">?</span></span>
        <span class="crow__reason">${escapeHtml(why)}</span>
      </div>`;
    }
    const isBest = res.best && r.id === res.best.id;
    const width = Math.max(4, (r.total / maxTotal) * 100);
    return `<div class="crow ${isBest ? 'crow--best' : ''}">
      <span class="crow__name">${r.name}${isBest ? '<span class="crow__tag">лучший</span>' : ''}</span>
      <span class="crow__sum">${formatMoney(r.total)}</span>
      <span class="crow__bar"><i style="width:${width}%"></i></span>
    </div>`;
  }).join('');
}

// --- PRO: детальная разбивка с мини-графиками состава нагрузки ---
function renderDetail(res) {
  const avail = res.regimes.filter((r) => r.available);
  if (!avail.length) {
    $('detailContent').innerHTML = '<p class="disclaimer">Нет доступных режимов при текущих параметрах.</p>';
    return;
  }
  const maxTotal = Math.max(...avail.map((r) => r.total), 1);
  // Сортируем по возрастанию нагрузки — лучший сверху.
  const sorted = [...avail].sort((a, b) => a.total - b.total);

  const blocks = sorted.map((r) => {
    const isBest = res.best && r.id === res.best.id;
    // Доли налога / взносов / НДС внутри общей нагрузки для составного бара.
    const parts = [
      { v: r.tax, key: 'tax', label: 'налог' },
      { v: r.contributions, key: 'contrib', label: 'взносы' },
      { v: r.vat, key: 'vat', label: 'НДС' },
    ].filter((p) => p.v > 0);
    const widthPct = (r.total / maxTotal) * 100;
    const segs = parts.map((p) => {
      const w = r.total > 0 ? (p.v / r.total) * 100 : 0;
      return `<span class="seg seg--${p.key}" style="width:${w}%" title="${p.label}: ${formatMoney(p.v)}"></span>`;
    }).join('');

    return `
    <div class="detail-block ${isBest ? 'detail-block--best' : ''}">
      <div class="detail-head">
        <span class="detail-name">${r.name}${isBest ? ' <span class="detail-badge">лучший</span>' : ''}</span>
        <span class="detail-total">${formatMoney(r.total)}</span>
      </div>
      <div class="detail-track" style="width:${Math.max(8, widthPct)}%">${segs}</div>
      <div class="detail-meta">
        ${parts.map((p) => `<span class="dot dot--${p.key}">${p.label} ${formatMoney(p.v)}</span>`).join('')}
        <span class="detail-rate">ставка ${formatPercent(r.effectiveRate)}</span>
      </div>
    </div>`;
  }).join('');

  // Легенда цветов сегментов.
  const legend = `<div class="detail-legend">
    <span class="dot dot--tax">налог</span>
    <span class="dot dot--contrib">страховые взносы</span>
    <span class="dot dot--vat">НДС</span>
  </div>`;

  $('detailContent').innerHTML = legend + blocks;
}

// --- PRO: сценарии роста и точки перелома ---
function renderScenarios(input) {
  const points = [input.revenue, input.revenue * 3, input.revenue * 6].map((v) => Math.round(v));
  const labels = ['Сейчас', '×3', '×6'];
  const sweep = breakevenSweep({
    ...input,
    expenseShare: input.revenue > 0 ? input.expenses / input.revenue : 0.4,
  }, points);

  const head = `<tr><th>Выручка</th>${labels.map((l, i) => `<th>${l}<br>${formatShort(points[i])}</th>`).join('')}</tr>`;
  const bestRow = `<tr><td>Лучший режим</td>${sweep.map((s) => `<td class="scen-best">${s.best ? shortName(s.best.id) : '—'}</td>`).join('')}</tr>`;
  const taxRow = `<tr><td>Налог в год</td>${sweep.map((s) => `<td>${formatShort(s.minTotal)}</td>`).join('')}</tr>`;
  const rateRow = `<tr><td>Эфф. ставка</td>${sweep.map((s) => `<td>${formatPercent(s.effectiveRate)}</td>`).join('')}</tr>`;

  let breakpointHtml = '';
  const bp = sweep.find((s) => s.isBreakpoint);
  if (bp) {
    breakpointHtml = `<div class="breakpoint">🎯 <b>Точка перелома:</b> при выручке около ${formatShort(bp.revenue)} выгоднее перейти на <b>${bp.best ? bp.best.name : '—'}</b>.</div>`;
  } else {
    breakpointHtml = `<div class="breakpoint">При таком росте выгодный режим не меняется — <b>${sweep[0].best ? sweep[0].best.name : '—'}</b> остаётся оптимальным.</div>`;
  }

  // Мини-график кривой налога по сценариям (столбики высотой по нагрузке).
  const maxTax = Math.max(...sweep.map((s) => s.minTotal || 0), 1);
  const chart = `<div class="scen-chart">${sweep.map((s, i) => {
    const h = Math.max(6, ((s.minTotal || 0) / maxTax) * 100);
    return `<div class="scen-col">
      <div class="scen-col__val">${formatShort(s.minTotal)}</div>
      <div class="scen-col__bar" style="height:${h}%"></div>
      <div class="scen-col__lbl">${labels[i]}<br><span>${formatShort(points[i])}</span></div>
    </div>`;
  }).join('')}</div>`;

  $('scenContent').innerHTML =
    chart +
    `<table class="scen-table">${head}${bestRow}${taxRow}${rateRow}</table>${breakpointHtml}` +
    `<button class="btn btn--primary pdf-btn" id="pdfBtn">📄 Сохранить PDF-отчёт</button>`;

  $('pdfBtn').addEventListener('click', exportPdf);
}

// --- PRO: «вердикт» словами — главный вывод для пользователя ---
function renderVerdict(res, input) {
  const el = $('verdictContent');
  if (!el) return;
  if (!res.best) { el.innerHTML = '<p class="disclaimer">При текущих параметрах ни один режим не доступен.</p>'; return; }

  const best = res.best;
  // Второй по выгоде режим — чтобы показать «насколько лучший впереди».
  const others = res.regimes.filter((r) => r.available && r.id !== best.id).sort((a, b) => a.total - b.total);
  const runnerUp = others[0];
  const gap = runnerUp ? runnerUp.total - best.total : 0;

  const parts = [];
  parts.push(`Вам выгоднее всего <b>${best.name}</b> — налоговая нагрузка <b>${formatMoney(best.total)}</b> в год (${formatPercent(best.effectiveRate)} от выручки).`);
  if (res.savings > 0) parts.push(`Это на <b>${formatMoney(res.savings)}</b> меньше, чем при самом невыгодном из доступных режимов.`);
  if (runnerUp && gap > 0) parts.push(`Ближайшая альтернатива — ${runnerUp.name} (дороже на ${formatMoney(gap)}).`);

  // Практический совет по росту выручки.
  const sweep = breakevenSweep({ ...input, expenseShare: input.revenue > 0 ? input.expenses / input.revenue : 0.4 }, [input.revenue, input.revenue * 3, input.revenue * 6]);
  const bp = sweep.find((s) => s.isBreakpoint);
  if (bp && bp.best) parts.push(`📈 Если выручка вырастет примерно до ${formatShort(bp.revenue)} — пора переходить на ${bp.best.name}.`);

  el.innerHTML = `<div class="verdict">
    <div class="verdict__icon">✓</div>
    <div class="verdict__text">${parts.map((p) => `<p>${p}</p>`).join('')}</div>
  </div>`;
}

// Защита от поломки разметки при подстановке текста причин.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Тап по недоступной строке раскрывает причину (на мобильном :hover нет).
$('compareList').addEventListener('click', (e) => {
  const row = e.target.closest('.crow--off');
  if (row) {
    row.classList.toggle('is-open');
    tg?.HapticFeedback?.selectionChanged?.();
  }
});

function shortName(id) {
  return { npd: 'НПД', usn6: 'УСН 6%', usn15: 'УСН 15%', psn: 'ПСН', ausn8: 'АУСН 8%', ausn20: 'АУСН 20%' }[id] || id;
}

// --- PDF-отчёт (Pro) ---
// Печатаем расчёт через окно печати браузера → «Сохранить как PDF».
// Работает и в Telegram, и в обычном браузере, без внешних библиотек.
function exportPdf() {
  if (!lastResult) return;
  const res = lastResult, input = lastInput;
  const avail = res.regimes.filter((r) => r.available);
  const maxTotal = Math.max(...avail.map((r) => r.total), 1);

  // Строки таблицы с мини-баром нагрузки прямо в ячейке.
  const rows = [...res.regimes]
    .sort((a, b) => (a.available !== b.available ? (a.available ? -1 : 1) : a.total - b.total))
    .map((r) => {
      if (!r.available) {
        const why = (r.reasons && r.reasons[0]) ? r.reasons[0] : 'недоступен';
        return `<tr class="off"><td>${r.name}</td><td colspan="4">${why}</td></tr>`;
      }
      const best = res.best && r.id === res.best.id;
      const w = (r.total / maxTotal) * 100;
      return `<tr class="${best ? 'b' : ''}">
        <td>${r.name}${best ? ' <span class="tag">лучший</span>' : ''}</td>
        <td>${formatMoney(r.tax)}</td>
        <td>${formatMoney(r.contributions)}</td>
        <td>${formatMoney(r.vat)}</td>
        <td><b>${formatMoney(r.total)}</b><div class="minibar"><i style="width:${w}%"></i></div></td>
      </tr>`;
    }).join('');

  // Сценарии роста для отчёта.
  const pts = [input.revenue, input.revenue * 3, input.revenue * 6].map((v) => Math.round(v));
  const sweep = breakevenSweep({ ...input, expenseShare: input.revenue > 0 ? input.expenses / input.revenue : 0.4 }, pts);
  const scenRows = sweep.map((s, i) => `<tr><td>${['Сейчас', 'Через год-два', 'Долгосрочно'][i]} · ${formatShort(pts[i])}</td><td>${s.best ? s.best.name : '—'}</td><td><b>${formatMoney(s.minTotal)}</b></td><td>${formatPercent(s.effectiveRate)}</td></tr>`).join('');
  const bp = sweep.find((s) => s.isBreakpoint);

  const verdict = res.best
    ? `Оптимальный режим — <b>${res.best.name}</b> с нагрузкой ${formatMoney(res.best.total)} в год` +
      (res.savings > 0 ? `. Экономия до ${formatMoney(res.savings)} по сравнению с самым невыгодным вариантом.` : '.') +
      (bp && bp.best ? ` При росте выручки до ~${formatShort(bp.revenue)} стоит перейти на ${bp.best.name}.` : '')
    : 'При указанных параметрах ни один режим не доступен.';

  const today = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

  // Логотип-знак как inline SVG (не зависит от сети при печати).
  const logoSvg = `<svg width="40" height="40" viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#a855f7"/></linearGradient></defs><rect width="24" height="24" rx="6" fill="url(#g)"/><path d="M5 16l4-4 3 3 6-7" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 8h4v4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Налоговый отчёт ИП — ${today}</title>
  <style>
    *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f1120;padding:0;margin:0}
    .page{max-width:780px;margin:0 auto;padding:40px 44px}
    .head{display:flex;align-items:center;gap:14px;padding-bottom:18px;border-bottom:2px solid #ece9fb}
    .head .brand{font-size:18px;font-weight:800;letter-spacing:-.01em}
    .head .meta{margin-left:auto;text-align:right;font-size:12px;color:#7c809a}
    h1{font-size:20px;margin:24px 0 2px;letter-spacing:-.01em}
    .lead{color:#6b7090;font-size:13px;margin-bottom:22px}
    .verdict{background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;border-radius:14px;padding:20px 22px;margin-bottom:24px}
    .verdict .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.85;font-weight:700}
    .verdict .big{font-size:24px;font-weight:800;margin:6px 0}
    .verdict p{font-size:13.5px;line-height:1.55;margin:8px 0 0;opacity:.96}
    .params{display:grid;grid-template-columns:1fr 1fr;gap:8px 28px;background:#f7f8fc;border-radius:12px;padding:16px 20px;margin-bottom:26px;font-size:13.5px}
    .params div{display:flex;justify-content:space-between}.params span{color:#6b7090}
    h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#6b7090;margin:26px 0 10px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{padding:10px 8px;text-align:right;border-bottom:1px solid #ececf4;vertical-align:top}
    th:first-child,td:first-child{text-align:left} th{color:#9095ad;font-size:10.5px;text-transform:uppercase;font-weight:700}
    tr.b td{background:#f1fbf6} tr.b{font-weight:600} tr.off{color:#a6abc2}
    .tag{font-size:9.5px;font-weight:800;color:#fff;background:#10b981;padding:1px 6px;border-radius:99px;vertical-align:middle}
    .minibar{height:5px;background:#eef0f7;border-radius:99px;margin-top:5px;overflow:hidden}
    .minibar i{display:block;height:100%;background:linear-gradient(90deg,#6366f1,#a855f7)}
    .foot{margin-top:30px;padding-top:16px;border-top:1px solid #ececf4;font-size:10.5px;color:#9095ad;line-height:1.6}
    @media print{.page{padding:24px}}
  </style></head><body><div class="page">
    <div class="head">${logoSvg}<div class="brand">Налоговый навигатор<br><span style="font-size:11px;font-weight:500;color:#7c809a">ИП · 2026</span></div>
      <div class="meta">Отчёт от ${today}<br>${input.employees != null ? '' : ''}</div></div>

    <h1>Сравнение налоговых режимов</h1>
    <div class="lead">Персональный расчёт на основе ваших показателей за год</div>

    ${res.best ? `<div class="verdict"><div class="lbl">Рекомендация</div><div class="big">${res.best.name}</div><p>${verdict}</p></div>` : ''}

    <div class="params">
      <div><span>Выручка за год</span><b>${formatMoney(input.revenue)}</b></div>
      <div><span>Расходы за год</span><b>${formatMoney(input.expenses)}</b></div>
      <div><span>Доля выручки от физлиц</span><b>${Math.round(input.individualsShare * 100)}%</b></div>
      <div><span>Наёмных работников</span><b>${input.employees}</b></div>
    </div>

    <h2>Все режимы</h2>
    <table><tr><th>Режим</th><th>Налог</th><th>Взносы</th><th>НДС</th><th>Итого нагрузка</th></tr>${rows}</table>

    <h2>Прогноз при росте выручки</h2>
    <table><tr><th>Сценарий</th><th>Лучший режим</th><th>Налог в год</th><th>Ставка</th></tr>${scenRows}</table>

    <div class="foot">Расчёт упрощён и носит справочный характер; не является индивидуальной налоговой консультацией.
    Не учитывает торговый сбор, региональные пониженные ставки и специфику отдельных видов деятельности.
    Основано на НК РФ (гл. 26.2, 26.5, 26.7, 26.8) и ФЗ от 28.11.2025 № 425-ФЗ.
    Сформировано сервисом «Налоговый навигатор ИП 2026».</div>
  </div></body></html>`;

  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 350); }
  else { tg?.showAlert?.('Разрешите всплывающие окна, чтобы сохранить PDF.'); }
}

// --- PRO: налоговый календарь под лучший режим ---
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const KIND_ICON = { 'Взносы': '💰', 'Аванс': '📤', 'Уведомление': '✉️', 'Отчётность': '📋', 'Налог': '📤', 'Патент': '🧾' };

function renderCalendar(res) {
  const el = $('calContent');
  if (!el) return;
  if (!res.best) { el.innerHTML = '<p class="disclaimer">Выберите параметры — покажем сроки под ваш режим.</p>'; return; }

  // Date.now() здесь допустим — это реальное приложение в браузере (не движок/воркфлоу).
  const now = new Date();
  const events = getTaxCalendar(res.best.id, now);

  if (!events.length) {
    el.innerHTML = `<p class="disclaimer">Для режима «${res.best.name}» особых дат уплаты нет: налог удерживается автоматически, отдельной отчётности и взносов ИП за себя не предусмотрено.</p>`;
    return;
  }

  const fmtDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS_RU[m - 1]}`; };
  const next = events.find((e) => !e.isPast);

  // Подзаголовок: ближайшая дата.
  let header = '';
  if (next) {
    const inDays = next.daysLeft === 0 ? 'сегодня' : next.daysLeft === 1 ? 'завтра' : `через ${next.daysLeft} дн.`;
    header = `<div class="cal-next">Ближайшее: <b>${next.title}</b> — ${fmtDate(next.date)} (${inDays})</div>`;
  } else {
    header = `<div class="cal-next cal-next--done">Все даты ${now.getFullYear()} года пройдены ✓</div>`;
  }

  const items = events.map((e) => {
    const cls = e.isPast ? 'cal-row cal-row--past' : (e === next ? 'cal-row cal-row--next' : 'cal-row');
    const badge = e.isPast ? '<span class="cal-check">✓</span>' : `<span class="cal-days">${e.daysLeft === 0 ? 'сегодня' : e.daysLeft + ' дн.'}</span>`;
    return `<div class="${cls}">
      <span class="cal-date">${fmtDate(e.date)}</span>
      <span class="cal-body"><span class="cal-kind">${KIND_ICON[e.kind] || '•'} ${e.kind}</span><span class="cal-title">${escapeHtml(e.title)}</span></span>
      ${badge}
    </div>`;
  }).join('');

  el.innerHTML = header + `<div class="cal-list">${items}</div>` +
    `<p class="cal-note">Сроки для режима «${escapeHtml(res.best.name)}». При совпадении с выходным дата переносится на ближайший рабочий день.</p>`;
}

// --- PRO: черновик декларации УСН «Доходы» ---
// Состояние храним отдельно, чтобы поквартальный ввод не сбрасывался при пересчёте.
let declState = null;

function renderDeclaration(res, input) {
  const el = $('declContent');
  if (!el) return;

  // Декларация УСН Доходы актуальна только для УСН6. Для других режимов — пояснение.
  const usn6 = res.regimes.find((r) => r.id === 'usn6');
  const isUsn6Best = res.best && res.best.id === 'usn6';

  // Инициализируем состояние один раз: годовой доход делим на 4 как стартовую подсказку,
  // взносы кладём в 4 квартал (типичный сценарий ИП без работников).
  if (!declState) {
    const q = Math.round((input.revenue || 0) / 4);
    const contribYear = usn6 ? usn6.contributions : 0;
    declState = {
      incomeQ: [q, q, q, input.revenue - q * 3],
      contributionsQ: [0, 0, 0, contribYear],
      employees: input.employees || 0,
    };
  } else {
    declState.employees = input.employees || 0; // работники тянем из основной формы
  }

  const note = isUsn6Best
    ? `<p class="decl-hint">Заполнено из вашего расчёта. Уточните доходы и уплаченные взносы по кварталам — и сформируйте черновик.</p>`
    : `<p class="decl-hint">Декларацию сдают только на УСН (на ПСН/НПД/АУСН — не нужно). Черновик считается для УСН «Доходы» 6% — заполните, если вы на этом режиме.</p>`;

  const qLabels = ['I кв', 'Полугодие↑', '9 мес↑', 'Год↑'];
  const incFields = declState.incomeQ.map((v, i) =>
    `<label class="decl-cell"><span>Доход, ${['I кв','II кв','III кв','IV кв'][i]}</span>
      <input type="text" inputmode="numeric" class="decl-inc" data-i="${i}" value="${v ? v.toLocaleString('ru-RU') : ''}" /></label>`
  ).join('');
  const conFields = declState.contributionsQ.map((v, i) =>
    `<label class="decl-cell"><span>Взносы, ${['I кв','II кв','III кв','IV кв'][i]}</span>
      <input type="text" inputmode="numeric" class="decl-con" data-i="${i}" value="${v ? v.toLocaleString('ru-RU') : ''}" /></label>`
  ).join('');

  el.innerHTML = note +
    `<div class="decl-grid">${incFields}</div>` +
    `<div class="decl-grid">${conFields}</div>` +
    `<div class="decl-sum" id="declSum"></div>` +
    `<button class="btn btn--primary" id="declBtn">📄 Сформировать черновик декларации</button>`;

  // Обработчики ввода — пересчитываем сводку «налог к уплате» вживую.
  el.querySelectorAll('.decl-inc, .decl-con').forEach((inp) => {
    inp.addEventListener('input', () => {
      const i = +inp.dataset.i;
      const val = parseMoney(inp.value);
      if (inp.classList.contains('decl-inc')) declState.incomeQ[i] = val;
      else declState.contributionsQ[i] = val;
      updateDeclSum();
    });
  });
  $('declBtn').addEventListener('click', exportDeclaration);
  updateDeclSum();
}

function updateDeclSum() {
  const sumEl = $('declSum');
  if (!sumEl || !declState) return;
  const d = buildUsnIncomeDeclaration(declState);
  sumEl.innerHTML =
    `<div class="decl-sum__row"><span>Доход за год</span><b>${formatMoney(d.totals.incomeYear)}</b></div>` +
    `<div class="decl-sum__row"><span>Налог 6%</span><b>${formatMoney(d.totals.taxBeforeDeduction)}</b></div>` +
    `<div class="decl-sum__row"><span>Вычет взносов</span><b>−${formatMoney(d.totals.deductionYear)}</b></div>` +
    `<div class="decl-sum__row decl-sum__row--total"><span>Налог УСН к уплате за год</span><b>${formatMoney(d.totals.taxToPayYear)}</b></div>`;
}

function exportDeclaration() {
  if (!declState) return;
  const d = buildUsnIncomeDeclaration(declState);
  const s21 = d.section211, s11 = d.section11;
  const today = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  const m = (v) => formatMoney(v);

  const line = (code, name, val) => `<tr><td class="c">${code}</td><td>${name}</td><td class="v">${m(val)}</td></tr>`;

  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Черновик декларации УСН — ${today}</title>
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

  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 350); }
  else { tg?.showAlert?.('Разрешите всплывающие окна, чтобы сохранить черновик.'); }
}

// --- Управление Pro-замком ---
function applyProLock() {
  const sections = {
    proVerdict: 'verdictContent',
    proDetail: 'detailContent',
    proScenarios: 'scenContent',
    proCalendar: 'calContent',
    proDeclaration: 'declContent',
  };
  Object.entries(sections).forEach(([id, target]) => {
    const sec = $(id);
    if (isPro) {
      sec.classList.remove('locked');
      sec.querySelector('.pro-lock-cta')?.remove();
      sec.querySelector('.pro-badge').textContent = 'PRO ✓';
    } else {
      sec.classList.add('locked');
      if (!sec.querySelector('.pro-lock-cta')) {
        const cta = document.createElement('div');
        cta.className = 'pro-lock-cta';
        cta.innerHTML = `<div class="lk">🔒</div><p>Доступно в Pro</p>`;
        cta.addEventListener('click', openPaywall);
        sec.appendChild(cta);
      }
      // плейсхолдер под блюром
      if (!$(target).innerHTML) $(target).innerHTML = '<div style="height:120px"></div>';
    }
  });
}

// --- Paywall и оплата ---
function openPaywall() {
  tg?.HapticFeedback?.impactOccurred?.('light');
  $('paywall').hidden = false;
}
function closePaywall() { $('paywall').hidden = true; }
$('paywall').querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closePaywall));

$('buyProBtn').addEventListener('click', async () => {
  // Показываем сообщение И всплывашкой, И видимым текстом в окне (showAlert иногда молчит).
  const alertMsg = (m) => {
    const note = $('payNote');
    if (note) { note.textContent = m; note.style.display = 'block'; }
    try { if (tg?.showAlert) tg.showAlert(m); else alert(m); } catch (_) {}
  };
  alertMsg('Создаём счёт…'); // сразу видимый отклик, что нажатие сработало
  if (!tg) {
    unlockPro();
    return;
  }
  if (!BACKEND_READY) {
    alertMsg('Оплата Pro скоро откроется. Следите за обновлениями бота!');
    return;
  }
  try {
    // Таймаут 20 сек — чтобы не висеть вечно на «Создаём счёт…».
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(`${BACKEND_URL}/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    // Если сервер вернул ошибку или не дал ссылку — показываем причину (а не молчим).
    if (!res.ok || data.error) {
      alertMsg('Не удалось создать счёт: ' + (data.error || ('код ' + res.status)) + '. Напишите нам, мы поможем.');
      return;
    }
    if (data.alreadyPro) { unlockPro(); return; }
    if (!data.invoiceLink) {
      alertMsg('Сервер не вернул ссылку на оплату. Попробуйте позже.');
      return;
    }
    // Прячем «Создаём счёт…» — ссылка получена, открываем оплату.
    const note = $('payNote'); if (note) note.style.display = 'none';

    // Открываем счёт. openInvoice принимает slug или полную ссылку t.me/$...
    if (tg.openInvoice) {
      tg.openInvoice(data.invoiceLink, (status) => {
        if (status === 'paid') {
          unlockPro();
          tg.HapticFeedback?.notificationOccurred?.('success');
          alertMsg('Pro активирован! Спасибо за покупку 🎉');
        } else if (status === 'failed') {
          alertMsg('Оплата не прошла. Попробуйте ещё раз.');
        } else if (status === 'cancelled') {
          if (note) note.style.display = 'none';
        }
      });
    } else if (tg.openTelegramLink) {
      // Запасной путь для старых клиентов: открываем счёт как ссылку t.me.
      tg.openTelegramLink(data.invoiceLink);
    } else {
      alertMsg('Оплата работает в приложении Telegram (телефон/компьютер), не в веб-версии. Откройте бота в приложении.');
    }
  } catch (e) {
    const msg = e?.name === 'AbortError'
      ? 'Сервер оплаты долго не отвечает. Попробуйте ещё раз через минуту.'
      : 'Ошибка связи с сервером оплаты: ' + (e?.message || 'неизвестно') + '.';
    alertMsg(msg);
  }
});

function unlockPro() {
  isPro = true;
  closePaywall();
  applyProLock();
  recalc();
}

// --- Активация по коду доступа ---
$('haveCodeBtn')?.addEventListener('click', () => {
  const box = $('codeBox');
  box.hidden = !box.hidden;
  if (!box.hidden) $('codeInput')?.focus();
});

$('redeemBtn')?.addEventListener('click', redeemCode);
$('codeInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') redeemCode(); });

function redeemCode() {
  const input = $('codeInput');
  const msg = $('codeMsg');
  const raw = input.value.trim();
  if (!raw) { showCodeMsg(msg, 'Введите код доступа.', false); return; }
  const res = validateCode(raw);
  if (!res.valid) {
    showCodeMsg(msg, 'Код неверный. Проверьте и попробуйте ещё раз.', false);
    tg?.HapticFeedback?.notificationOccurred?.('error');
    return;
  }
  // Сохраняем код на устройстве — Pro останется активным после перезапуска.
  try { localStorage.setItem(PRO_CODE_KEY, raw.toUpperCase()); } catch (_) {}
  showCodeMsg(msg, 'Код принят! Pro активирован 🎉', true);
  tg?.HapticFeedback?.notificationOccurred?.('success');
  setTimeout(() => { unlockPro(); }, 700);
}

function showCodeMsg(el, text, ok) {
  el.textContent = text;
  el.className = 'code-msg ' + (ok ? 'code-msg--ok' : 'code-msg--err');
}

// Ссылка на политику конфиденциальности — открываем во внешнем браузере Telegram.
$('privacyLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (tg?.openLink) tg.openLink(PRIVACY_URL);
  else window.open(PRIVACY_URL, '_blank');
});

// --- Старт ---
restoreInputs();
applyProLock();
recalc();
