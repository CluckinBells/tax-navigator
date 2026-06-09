// Telegram Mini App — Налоговый навигатор ИП 2026.
// Использует общий движок расчёта (тот же, что и на лендинге).

import { calculateAll, breakevenSweep, getTaxCalendar } from '../shared/engine.js';
import { formatMoney, formatPercent, formatShort, parseMoney } from '../shared/format.js';
import { buildUsnIncomeDeclaration } from '../shared/declaration.js';
import { computeSetAside } from '../shared/setaside.js';
import { formatDateRu } from '../shared/reminders.js';

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
const PRIVACY_URL = 'https://navnalog.ru/privacy.html';

// ВАЖНО: BACKEND_READY объявлен ДО блока инициализации ниже. Иначе verifyProWithBackend(),
// вызываемый при запуске, читает его в «мёртвой зоне» (TDZ) и падает — из-за этого Pro
// не подхватывался с сервера при запуске. Это был баг с пропадающим Pro.
const BACKEND_READY = !BACKEND_URL.includes('example.com'); // бэкенд настроен (адрес не заглушка)

// --- Инициализация Telegram ---
let isPro = false;
if (tg) {
  tg.ready();
  tg.expand();
  // setHeaderColor поддерживается с Bot API 6.1 — на старых клиентах не вызываем (иначе варнинг).
  if (tg.isVersionAtLeast?.('6.1')) tg.setHeaderColor('secondary_bg_color');
  // Pro-статус определяет ТОЛЬКО сервер по подписи initData (см. bot/server.js).
  // Клиентских кодов больше нет — никакого предварительного клиентского Pro.
  verifyProWithBackend();
}

// Включение напоминаний: deep-link в бота. Семья режима → суффикс параметра start=.
const BOT_USERNAME = 'taxes_navigator_bot';
const REM_FAMILY_BY_REGIME = { usn6: 'usn', usn15: 'usn', psn: 'psn', ausn8: 'ausn', ausn20: 'ausn' };
const FAMILY_LABEL = { usn: 'УСН', psn: 'Патент', ausn: 'АУСН' };
// Виральный шеринг: ссылка ведёт сразу в бота с меткой источника (её считает /srcstats).
const SHARE_LINK = `https://t.me/${BOT_USERNAME}?start=share`;

// --- Веб-режим: оплата Pro на сайте (без Telegram) ---
// В обычном браузере (не в Telegram) tg.initData пуст → веб-оплата ЮKassa + токен в localStorage.
const WEB_TOKEN_KEY = 'tn_web_token';
const isTelegram = () => !!(tg && tg.initData);
let webToken = '';

// Проверка веб-Pro: токен из ?paid=... или localStorage → спрашиваем сервер /web/pro.
async function verifyWebPro() {
  if (!BACKEND_READY) return;
  const params = new URLSearchParams(location.search);
  const fromUrl = (params.get('paid') || '').trim();
  if (fromUrl) { try { localStorage.setItem(WEB_TOKEN_KEY, fromUrl); } catch (_) {} } // сразу сохраняем токен возврата (вдруг вебхук задержится)
  if (params.has('paid')) history.replaceState(null, '', location.pathname + location.hash); // прячем токен из адреса
  const token = fromUrl || (localStorage.getItem(WEB_TOKEN_KEY) || '').trim();
  if (!token) return;
  // Вебхук ЮKassa может прийти на пару секунд позже редиректа — если только что вернулись с оплаты, повторяем проверку.
  const attempts = fromUrl ? 6 : 1;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BACKEND_URL}/web/pro`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const data = await res.json().catch(() => ({}));
      if (data.isPro) {
        webToken = token;
        if (!isPro) { isPro = true; applyProLock(); recalc(); }
        showWebClaim(token, !!fromUrl);
        return;
      }
    } catch (_) {}
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2500)); // ждём подтверждение оплаты вебхуком
  }
}

// Запуск веб-оплаты: email для чека → сервер создаёт платёж ЮKassa → редирект на оплату.
async function startWebPayment() {
  const box = $('webPayBox'); if (box) box.hidden = false;
  const note = $('payNote');
  const say = (m) => { if (note) { note.textContent = m; note.style.display = 'block'; } };
  const email = ($('webEmail')?.value || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { say('Укажите email — на него придёт чек об оплате.'); $('webEmail')?.focus(); return; }
  say('Создаём оплату…');
  try {
    const res = await fetch(`${BACKEND_URL}/web/create-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.confirmationUrl) { say('Не удалось создать оплату: ' + (data.error || res.status) + '. Попробуйте позже.'); return; }
    window.location.href = data.confirmationUrl; // страница оплаты ЮKassa (тот же браузер, без Telegram)
  } catch (e) { say('Ошибка связи с сервером оплаты: ' + (e?.message || '') + '.'); }
}

// Пост-оплатный экран «Pro активен» + кнопка перенести доступ в Telegram (claim).
function showWebClaim(token, fresh) {
  const el = $('webClaim'); if (!el) return;
  const link = $('webClaimLink');
  if (link) link.href = `https://t.me/${BOT_USERNAME}?start=claim_${encodeURIComponent(token)}`;
  const title = $('webClaimTitle');
  if (title) title.textContent = fresh ? '🎉 Оплата прошла! Pro ваш навсегда' : '✅ Pro активен на этом устройстве';
  el.hidden = false;
  if (fresh) try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
}

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
    // Сервер — единственный источник правды по Pro (оплата ЮKassa).
    if (data.isPro && !isPro) { isPro = true; applyProLock(); recalc(); }
    else if (!data.isPro && isPro) {
      // Сервер говорит «не Pro» (например, после возврата) — забираем доступ.
      isPro = false; applyProLock(); recalc();
    }
  } catch (_) { /* бэкенд недоступен — остаёмся на предварительном статусе */ }
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
  renderRemindCta(res);
  renderShareCta(res);
  if (isPro) {
    renderVerdict(res, input);
    renderDetail(res);
    renderScenarios(input);
    renderCalendar(res);
    renderSetAside(res, input);
    renderDeclaration(res, input);
  }
}

// CTA «включить напоминания» (Pro): кнопка под лучший режим ведёт в бота;
// у пользователя без Pro — открывает пейволл.
function renderRemindCta(res) {
  const btn = $('remindBtn');
  if (!btn) return;
  const fam = res.best ? REM_FAMILY_BY_REGIME[res.best.id] : null;
  btn.dataset.param = fam ? `rem_${fam}` : 'reminders';
  if (!isPro) { btn.textContent = '🔔 Включить напоминания — в Pro'; return; }
  btn.textContent = fam ? `🔔 Напоминать о сроках (${FAMILY_LABEL[fam]})` : '🔔 Включить напоминания о сроках';
}
$('remindBtn').addEventListener('click', () => {
  if (!isPro) { openPaywall(); return; } // напоминания — часть Pro
  const param = $('remindBtn').dataset.param || 'reminders';
  const url = `https://t.me/${BOT_USERNAME}?start=${param}`;
  if (tg?.openTelegramLink) tg.openTelegramLink(url);
  else window.open(url, '_blank');
});

// --- Виральная карточка: поделиться расчётом (бесплатно, цикл ИП→ИП) ---
function buildShareText(res) {
  if (res && res.savings > 0) {
    return `Сравнил 6 налоговых режимов ИП на 2026. На невыгодном режиме переплата — до ${formatMoney(res.savings)} в год 😳 Посчитай свой за минуту 👇`;
  }
  return 'Сравнил 6 налоговых режимов ИП на 2026 за минуту. Посчитай и ты, где выгоднее 👇';
}

function renderShareCta(res) {
  const sec = $('shareCta');
  if (!sec) return;
  sec.hidden = false;
  const title = $('shareCtaTitle');
  const text = $('shareCtaText');
  if (res && res.savings > 0) {
    title.textContent = `Можно экономить до ${formatMoney(res.savings)} в год`;
    text.textContent = 'Поделись расчётом — знакомому ИП это тоже сэкономит деньги.';
  } else {
    title.textContent = 'Поделись калькулятором';
    text.textContent = 'Отправь знакомому ИП — пусть проверит свой режим за минуту.';
  }
}

$('shareBtn').addEventListener('click', () => {
  tg?.HapticFeedback?.impactOccurred?.('light');
  const text = buildShareText(lastResult);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(SHARE_LINK)}&text=${encodeURIComponent(text)}`;
  if (tg?.openTelegramLink) tg.openTelegramLink(shareUrl);
  else if (navigator.share) navigator.share({ text: `${text} ${SHARE_LINK}` }).catch(() => {});
  else window.open(shareUrl, '_blank');
});

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

// --- PDF-отчёт и черновик декларации (Pro) ---
// Документ формируется на отдельной странице print.html и открывается в НАСТОЯЩЕМ браузере
// через tg.openLink. В WebView Telegram window.open('','_blank') даёт пустую вкладку, поэтому
// данные передаём в print.html через hash, а печать («Сохранить как PDF») делает уже браузер.
function openPrintable(type, payload) {
  let enc;
  try {
    enc = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // base64url — безопасно в hash
  } catch (e) { tg?.showAlert?.('Не удалось сформировать документ.'); return; }
  const url = new URL('print.html', location.href);
  url.hash = `t=${type}&d=${enc}`;
  if (tg?.openLink) tg.openLink(url.href);
  else window.open(url.href, '_blank');
}

function exportPdf() {
  if (!lastInput) return;
  openPrintable('report', lastInput);
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

// --- PRO: налоговая подушка (сколько отложить на налоги) ---
// Состояние храним отдельно, чтобы ручные правки не сбрасывались при пересчёте.
let setAsideState = null;

function renderSetAside(res, input) {
  const el = $('setAsideContent');
  if (!el) return;
  const regimeId = res.best ? res.best.id : 'usn6';
  const profitBased = regimeId === 'usn15' || regimeId === 'ausn20';

  // Инициализируем из основного расчёта; пересоздаём, если сменился лучший режим.
  if (!setAsideState || setAsideState.regimeId !== regimeId) {
    setAsideState = {
      regimeId,
      incomeToDate: input.revenue || 0,
      expensesToDate: input.expenses || 0,
      paid: 0,
    };
  }

  const expRow = profitBased
    ? `<label class="sa-cell"><span>Расходы с начала года, ₽</span>
        <input type="text" inputmode="numeric" id="saExpenses" value="${setAsideState.expensesToDate ? setAsideState.expensesToDate.toLocaleString('ru-RU') : ''}" /></label>`
    : '';

  el.innerHTML =
    `<p class="sa-hint">Введите доход с начала года — покажем, сколько держать отложенным на налоги под режим «${escapeHtml(res.best ? res.best.name : '—')}».</p>` +
    `<div class="sa-grid">` +
      `<label class="sa-cell"><span>Доход с начала года, ₽</span>
        <input type="text" inputmode="numeric" id="saIncome" value="${setAsideState.incomeToDate ? setAsideState.incomeToDate.toLocaleString('ru-RU') : ''}" /></label>` +
      expRow +
      `<label class="sa-cell"><span>Уже уплачено в этом году, ₽</span>
        <input type="text" inputmode="numeric" id="saPaid" value="${setAsideState.paid ? setAsideState.paid.toLocaleString('ru-RU') : ''}" /></label>` +
    `</div>` +
    `<div id="saResult"></div>`;

  const onInput = () => {
    setAsideState.incomeToDate = parseMoney($('saIncome').value);
    if ($('saExpenses')) setAsideState.expensesToDate = parseMoney($('saExpenses').value);
    setAsideState.paid = parseMoney($('saPaid').value);
    updateSetAside(input);
  };
  el.querySelectorAll('#saIncome, #saExpenses, #saPaid').forEach((inp) => inp.addEventListener('input', onInput));
  updateSetAside(input);
}

function updateSetAside(input) {
  const el = $('saResult');
  if (!el || !setAsideState) return;
  const s = computeSetAside({
    regimeId: setAsideState.regimeId,
    incomeToDate: setAsideState.incomeToDate,
    expensesToDate: setAsideState.expensesToDate,
    paid: setAsideState.paid,
    individualsShare: input.individualsShare,
    employees: input.employees,
    ausnRegion: input.ausnRegion,
    patentAvailable: input.patentAvailable,
    patentCost: input.patentCost,
  });

  if (!s.available) {
    el.innerHTML = `<p class="sa-note">На доход ${formatMoney(setAsideState.incomeToDate)} режим «${escapeHtml(s.regimeName)}» недоступен (вероятно, превышен лимит). Измените параметры в форме выше.</p>`;
    return;
  }
  if (s.auto) {
    el.innerHTML =
      `<div class="sa-auto">⚙️ На АУСН налог считает банк и списывает автоматически — отдельно откладывать не нужно.</div>` +
      `<p class="sa-note">${escapeHtml(s.note)}</p>`;
    return;
  }

  const events = getTaxCalendar(setAsideState.regimeId, new Date());
  const next = events.find((e) => !e.isPast) || null;
  const pct = s.effectiveRate != null ? ` · ${formatPercent(s.effectiveRate)} от дохода` : '';
  const breakdown = [
    s.tax > 0 ? `<span class="sa-chip">налог ${formatMoney(s.tax)}</span>` : '',
    s.contributions > 0 ? `<span class="sa-chip">взносы ${formatMoney(s.contributions)}</span>` : '',
    s.vat > 0 ? `<span class="sa-chip">НДС ${formatMoney(s.vat)}</span>` : '',
  ].filter(Boolean).join('');
  const paidLine = s.paid > 0
    ? `<div class="sa-sub">Полная нагрузка ${formatMoney(s.burden)} − уплачено ${formatMoney(s.paid)}</div>` : '';
  const nextLine = next
    ? `<div class="sa-next">📅 Ближайший платёж: <b>${escapeHtml(next.title)}</b> — ${formatDateRu(next.date)} (${next.daysLeft === 0 ? 'сегодня' : next.daysLeft === 1 ? 'завтра' : 'через ' + next.daysLeft + ' дн.'}).</div>` : '';

  el.innerHTML =
    `<div class="sa-big"><span class="sa-big__label">Отложите на налоги</span>` +
    `<span class="sa-big__val">${formatMoney(s.setAside)}</span>` +
    `<span class="sa-big__sub">с дохода ${formatMoney(setAsideState.incomeToDate)}${pct}</span></div>` +
    paidLine +
    (breakdown ? `<div class="sa-chips">${breakdown}</div>` : '') +
    nextLine +
    `<p class="sa-note">${escapeHtml(s.note)}</p>` +
    `<p class="sa-disclaimer">Ориентир: точная сумма авансов зависит от того, когда вы платите взносы. Не заменяет расчёт бухгалтера.</p>`;
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
  openPrintable('decl', declState);
}

// --- Управление Pro-замком ---
function applyProLock() {
  const sections = {
    proVerdict: 'verdictContent',
    proDetail: 'detailContent',
    proScenarios: 'scenContent',
    proCalendar: 'calContent',
    proSetAside: 'setAsideContent',
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
  if (!isTelegram()) { return startWebPayment(); } // браузер (не Telegram, в т.ч. если Telegram-SDK не загрузился) → веб-оплата ЮKassa
  alertMsg('Создаём счёт…'); // сразу видимый отклик, что нажатие сработало
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
    const note = $('payNote');
    if (note) note.style.display = 'none';

    // openInvoice в разных версиях принимает по-разному: где-то полную ссылку
    // https://t.me/$SLUG, где-то только сам SLUG. Подстрахуемся — пробуем оба формата.
    const fullLink = data.invoiceLink;
    const slugMatch = fullLink.match(/\$([\w-]+)/);
    const slug = slugMatch ? slugMatch[1] : fullLink;

    const onStatus = (status) => {
      if (status === 'paid') {
        unlockPro();
        tg.HapticFeedback?.notificationOccurred?.('success');
        alertMsg('Pro активирован! Спасибо за покупку 🎉');
      } else if (status === 'failed') {
        alertMsg('Оплата не прошла. Попробуйте ещё раз.');
      } else if (note) {
        note.style.display = 'none'; // отмена/закрытие окна
      }
    };

    if (typeof tg.openInvoice === 'function') {
      // Пробуем сначала полную ссылку; если бросит — пробуем slug.
      try {
        tg.openInvoice(fullLink, onStatus);
      } catch (err1) {
        try {
          tg.openInvoice(slug, onStatus);
        } catch (err2) {
          alertMsg('Не удалось открыть окно оплаты. Откройте ссылку вручную: ' + fullLink);
        }
      }
    } else if (tg.openTelegramLink) {
      tg.openTelegramLink(fullLink);
    } else {
      alertMsg('Оплата работает в приложении Telegram (телефон/компьютер). Откройте бота в приложении.');
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
verifyWebPro();
if (!isTelegram()) { const b = $('webPayBox'); if (b) b.hidden = false; } // в браузере показываем поле email для веб-оплаты
// Вход «Купить картой» с лендинга (?buy=1) → сразу открываем окно оплаты с полем email.
if (new URLSearchParams(location.search).get('buy') === '1') { openPaywall(); setTimeout(() => $('webEmail')?.focus(), 120); }
