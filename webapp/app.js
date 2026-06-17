// Telegram Mini App — Налоговый навигатор ИП 2026.
// Использует общий движок расчёта (тот же, что и на лендинге).

import { calculateAll, breakevenSweep, getTaxCalendar } from '../shared/engine.js?v=44';
import { formatMoney, formatPercent, formatShort, parseMoney } from '../shared/format.js?v=44';
import { buildUsnIncomeDeclaration } from '../shared/declaration.js?v=44';
import { computeSetAside } from '../shared/setaside.js?v=44';
import { formatDateRu } from '../shared/reminders.js?v=44';

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
  // showPopup/showAlert работают только внутри реального Telegram — иначе (веб) alert.
  if (isTelegram() && tg?.showPopup) {
    tg.showPopup({ title: 'Подсказка', message: text, buttons: [{ type: 'ok' }] });
  } else if (isTelegram() && tg?.showAlert) {
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

// Проверка веб-Pro: токен живёт ТОЛЬКО в localStorage (кладётся до редиректа на оплату) →
// сервер /web/pro (он сам сверяет с ЮKassa по API). Возврат с оплаты помечается флагом ?paid=1 —
// токен в URL больше не передаётся (старый формат ?paid=<токен> поддержан для совместимости).
async function verifyWebPro() {
  if (!BACKEND_READY) return;
  const params = new URLSearchParams(location.search);
  const returned = params.has('paid'); // вернулись со страницы оплаты ЮKassa
  const legacy = (params.get('paid') || '').trim();
  if (legacy.length > 8) { try { localStorage.setItem(WEB_TOKEN_KEY, legacy); } catch (_) {} } // старые ссылки ?paid=<токен>
  if (returned) history.replaceState(null, '', location.pathname + location.hash); // чистим адрес
  const token = (localStorage.getItem(WEB_TOKEN_KEY) || '').trim() || (legacy.length > 8 ? legacy : '');
  if (!token) {
    if (returned) showWebStatus('Не нашли данные оплаты в этом браузере. Если деньги списались — напишите нам: filimonov.filimonov05@mail.ru');
    return;
  }
  if (returned) showWebStatus('⏳ Подтверждаем оплату, секунду…');
  const attempts = returned ? 8 : 1;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BACKEND_URL}/web/pro`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const data = await res.json().catch(() => ({}));
      if (data.isPro) {
        webToken = token;
        if (!isPro) { isPro = true; applyProLock(); recalc(); }
        if (returned && window.ym) ym(109693939, 'reachGoal', 'web_pro_paid'); // покупка Pro картой на сайте (реклама → реальные деньги)
        showWebClaim(token, returned);
        return;
      }
    } catch (_) {}
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2500));
  }
  if (returned) showWebStatus('Оплата обрабатывается. Если деньги списались — обновите страницу через минуту. Не помогло — напишите нам: filimonov.filimonov05@mail.ru');
}

// Запуск веб-оплаты: сразу создаём платёж ЮKassa → редирект на страницу оплаты (без поля email).
async function startWebPayment() {
  const note = $('payNote');
  const say = (m) => { if (note) { note.textContent = m; note.style.display = 'block'; } };
  say('Создаём оплату…');
  try {
    const res = await fetch(`${BACKEND_URL}/web/create-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.confirmationUrl) { say('Не удалось создать оплату: ' + (data.error || res.status) + '. Попробуйте позже.'); return; }
    // Токен покупки сохраняем ДО редиректа — в URL он больше не ходит (возврат придёт с ?paid=1).
    if (data.token) { try { localStorage.setItem(WEB_TOKEN_KEY, data.token); } catch (_) {} }
    if (window.ym) ym(109693939, 'reachGoal', 'web_checkout_start'); // дошёл до оплаты — промежуточная цель для оптимизации Директа
    window.location.href = data.confirmationUrl; // страница оплаты ЮKassa (тот же браузер, без Telegram)
  } catch (e) { say('Ошибка связи с сервером оплаты: ' + (e?.message || '') + '.'); }
}

// Пост-оплатный экран «Pro активен» + кнопка перенести доступ в Telegram (claim).
// Токен в ссылку НЕ кладём: по клику запрашиваем у сервера ОДНОРАЗОВЫЙ код активации
// (живёт ~15 минут, гаснет после использования) — утёкшая/пересланная ссылка бесполезна.
function showWebClaim(token, fresh) {
  const el = $('webClaim'); if (!el) return;
  const link = $('webClaimLink');
  if (link) {
    link.style.display = '';
    link.onclick = async (e) => {
      e.preventDefault();
      if (link.dataset.busy === '1') return; // защита от двойного клика (иначе второй код перезапишет первый → мёртвая ссылка)
      link.dataset.busy = '1';
      const old = link.textContent;
      link.textContent = '⏳ Готовим ссылку…';
      const reset = () => { link.textContent = old; link.dataset.busy = ''; };
      try {
        const res = await fetch(`${BACKEND_URL}/web/claim-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        const data = await res.json().catch(() => ({}));
        if (data.claimCode) {
          window.location.href = `https://t.me/${BOT_USERNAME}?start=claim_${encodeURIComponent(data.claimCode)}`;
          return; // busy не снимаем — уходим в Telegram
        }
        if (res.status === 409) { showWebStatus('Эта покупка уже привязана к Telegram — откройте бота @' + BOT_USERNAME + '.'); reset(); return; }
        alert('Не удалось подготовить ссылку (' + (data.error || res.status) + '). Попробуйте ещё раз.');
        reset();
      } catch (_) {
        alert('Ошибка связи с сервером. Попробуйте ещё раз через минуту.');
        reset();
      }
    };
  }
  const txt = el.querySelector('.pay-done__text'); if (txt) txt.style.display = '';
  const title = $('webClaimTitle');
  if (title) title.textContent = fresh ? '🎉 Оплата прошла! Pro ваш навсегда' : '✅ Pro активен на этом устройстве';
  el.hidden = false;
  if (fresh) try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
}

// Статус/ошибка в той же карточке (при подтверждении оплаты на возврате с ЮKassa).
function showWebStatus(msg) {
  const el = $('webClaim'); if (!el) return;
  const title = $('webClaimTitle'); if (title) title.textContent = msg;
  const txt = el.querySelector('.pay-done__text'); if (txt) txt.style.display = 'none';
  const link = $('webClaimLink'); if (link) link.style.display = 'none';
  el.hidden = false;
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
  renderProfile();
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
// Переход к напоминаниям (общий для кнопки на «Сроки» и в «Профиле»): Pro → deep-link в бота, иначе пейволл.
function goToReminders() {
  if (!isPro) { openPaywall(); return; } // напоминания — часть Pro
  const fam = lastResult && lastResult.best ? REM_FAMILY_BY_REGIME[lastResult.best.id] : null;
  const param = fam ? `rem_${fam}` : 'reminders';
  const url = `https://t.me/${BOT_USERNAME}?start=${param}`;
  // openTelegramLink существует и вне Telegram, но там молчит → гейт по isTelegram()
  if (isTelegram() && tg?.openTelegramLink) tg.openTelegramLink(url);
  else window.open(url, '_blank');
}
$('remindBtn').addEventListener('click', goToReminders);

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
  if (isTelegram() && tg?.openTelegramLink) tg.openTelegramLink(shareUrl);
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

// --- Нижняя таб-навигация (Расчёт / Сроки / Профиль) ---
const TAB_ORDER = ['calc', 'dates', 'profile'];
let currentTabIdx = 0;
function switchTab(name) {
  const newIdx = TAB_ORDER.indexOf(name);
  if (newIdx === -1 || newIdx === currentTabIdx) return;
  const cls = newIdx > currentTabIdx ? 'tab-in-fwd' : 'tab-in-back';
  TAB_ORDER.forEach((t) => {
    const p = $(`tab-${t}`);
    if (!p) return;
    const show = t === name;
    p.hidden = !show;
    if (show) {
      p.classList.remove('tab-in-fwd', 'tab-in-back');
      void p.offsetWidth; // рефлоу — гарантированно перезапускаем анимацию
      p.classList.add(cls);
    }
  });
  currentTabIdx = newIdx;
  document.querySelectorAll('.tabbar__btn').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  window.scrollTo({ top: 0 });
  tg?.HapticFeedback?.selectionChanged?.();
}
document.querySelectorAll('.tabbar__btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// Ссылки «Политика» и «Оферта» во вкладке «Профиль» — во внешний браузер.
$('privacyLink2')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (tg?.openLink) tg.openLink(PRIVACY_URL);
  else window.open(PRIVACY_URL, '_blank');
});
$('ofertaLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  const u = 'https://navnalog.ru/oferta.html';
  if (tg?.openLink) tg.openLink(u);
  else window.open(u, '_blank');
});
// Канал проекта — t.me открываем внутри Telegram, в браузере — новой вкладкой.
// Гейт по isTelegram(): openTelegramLink существует и вне Telegram, но там молчит.
$('channelLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  const u = 'https://t.me/navnalog';
  if (isTelegram() && tg?.openTelegramLink) tg.openTelegramLink(u);
  else window.open(u, '_blank');
});

// --- Профиль: хаб (статус с экономией, режим+напоминания, сохранённые расчёты, мои данные) ---
// Всё на устройстве (localStorage). Связывает калькулятор → сроки → статус в одном месте.
const SAVED_KEY = 'tn_saved_calcs';
const SAVED_MAX = 12;
const DEFAULT_INPUT = { revenue: 5000000, expenses: 2000000, individualsShare: 0.3, employees: 0, ausnRegion: true, patentAvailable: true, patentCost: 30000 };

function getSavedCalcs() {
  try { const a = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
function setSavedCalcs(list) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch (_) {} }
function setChip(chip, on) { chip.dataset.on = String(on); chip.querySelector('span').textContent = on ? 'Да' : 'Нет'; }

// Заполнить форму нормализованным input (из сохранённого расчёта / сброса данных).
function applyInputToForm(input) {
  F.revenue.value = input.revenue ? input.revenue.toLocaleString('ru-RU') : '';
  F.expenses.value = input.expenses ? input.expenses.toLocaleString('ru-RU') : '';
  const pct = Math.round((input.individualsShare || 0) * 100);
  F.individualsShare.value = pct; F.indivOut.textContent = pct + '%';
  F.employees.value = input.employees || 0;
  setChip(F.ausnRegion, !!input.ausnRegion);
  setChip(F.patentAvailable, !!input.patentAvailable);
  F.patentCostField.style.display = input.patentAvailable ? '' : 'none';
  F.patentCost.value = input.patentCost ? input.patentCost.toLocaleString('ru-RU') : '';
}

function saveCurrentCalc() {
  if (!lastInput || !lastResult) return;
  const best = lastResult.best;
  const item = {
    id: 'c' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name: `${best ? best.name : 'Расчёт'} · ${formatShort(lastInput.revenue || 0)}`,
    input: lastInput,
    bestName: best ? best.name : null,
    bestTotal: best ? best.total : 0,
  };
  const list = getSavedCalcs();
  list.unshift(item);
  if (list.length > SAVED_MAX) list.length = SAVED_MAX;
  setSavedCalcs(list);
  tg?.HapticFeedback?.notificationOccurred?.('success');
  renderSavedCalcs();
}
function loadCalc(id) {
  const c = getSavedCalcs().find((x) => x.id === id);
  if (!c || !c.input) return;
  applyInputToForm(c.input);
  recalc();
  switchTab('calc'); // показываем загруженный расчёт
  tg?.HapticFeedback?.impactOccurred?.('light');
}
function deleteCalc(id) {
  setSavedCalcs(getSavedCalcs().filter((x) => x.id !== id));
  tg?.HapticFeedback?.impactOccurred?.('light');
  renderSavedCalcs();
}
function clearMyData() {
  const doClear = () => {
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(SAVED_KEY); } catch (_) {}
    applyInputToForm(DEFAULT_INPUT); // сброс формы к значениям по умолчанию (Pro-токен НЕ трогаем)
    recalc();
    tg?.HapticFeedback?.notificationOccurred?.('success');
  };
  const msg = 'Введённые цифры и сохранённые расчёты будут удалены с этого устройства. Доступ к Pro сохранится.';
  // В реальном Telegram — нативный showPopup; в обычном браузере (веб-оплата) showPopup есть, но не
  // работает → используем confirm. Поэтому гейтим по isTelegram(), а не по наличию метода.
  if (isTelegram() && tg?.showPopup) {
    tg.showPopup({ title: 'Очистить мои данные?', message: msg, buttons: [{ id: 'ok', type: 'destructive', text: 'Очистить' }, { type: 'cancel' }] }, (id) => { if (id === 'ok') doClear(); });
  } else if (confirm(msg)) { doClear(); }
}

function renderSavedCalcs() {
  const el = $('profileSaved');
  if (!el) return;
  const list = getSavedCalcs();
  const rows = list.map((c) =>
    `<div class="scalc" data-paction="load-calc" data-id="${c.id}">
      <div class="scalc__main"><div class="scalc__name">${escapeHtml(c.name)}</div><div class="scalc__sub">выгодно: ${escapeHtml(c.bestName || '—')} · ${formatMoney(c.bestTotal)}/год</div></div>
      <button class="scalc__del" type="button" data-paction="del-calc" data-id="${c.id}" aria-label="Удалить">✕</button>
    </div>`
  ).join('');
  el.innerHTML =
    `<div class="card__title">Сохранённые расчёты${list.length ? ` <span class="card__hint">${list.length}/${SAVED_MAX}</span>` : ''}</div>` +
    (list.length ? `<div class="scalc-list">${rows}</div>` : `<p class="about-text">Сохраняйте расчёты («Мой бизнес», «Если найму 2 человек») — и возвращайтесь к ним в один тап.</p>`) +
    `<button class="btn btn--primary" type="button" data-paction="save-calc">💾 Сохранить текущий расчёт</button>`;
}

function renderProfile() {
  const res = lastResult;
  const ps = $('profileStatus');
  if (ps) {
    if (isPro) {
      ps.innerHTML = `<div class="pstatus"><span class="pstatus__icon">💎</span><div><div class="pstatus__title">Pro активен — навсегда</div><div class="pstatus__text">Открыто всё: разбор, сценарии, календарь, «подушка», декларация и напоминания. Обновления ставок 2026 включены.</div></div></div>`;
    } else {
      const save = res && res.savings > 0 ? ` и заберите свои <b>${formatMoney(res.savings)}</b> экономии в год` : '';
      ps.innerHTML = `<div class="pstatus"><span class="pstatus__icon">🔓</span><div><div class="pstatus__title">Бесплатная версия</div><div class="pstatus__text">Сравнение режимов и экономия — бесплатно. Откройте Pro${save}: разбор, сценарии, календарь с напоминаниями, «подушка» и черновик декларации.</div></div></div><button class="btn btn--primary" type="button" data-paction="buy">Открыть Pro — 299 ₽ навсегда</button>`;
    }
  }
  const pr = $('profileRegime');
  if (pr) {
    if (res && res.best) {
      const fam = REM_FAMILY_BY_REGIME[res.best.id];
      const remindLabel = !isPro ? '🔔 Включить напоминания — в Pro'
        : (fam ? `🔔 Напоминать о сроках (${FAMILY_LABEL[fam]})` : '🔔 Включить напоминания о сроках');
      pr.innerHTML =
        `<div class="card__title">Ваш режим</div>` +
        `<div class="pregime"><div><div class="pregime__name">${escapeHtml(res.best.name)}</div><div class="pregime__sub">по вашему расчёту · ${formatMoney(res.best.total)} налогов в год</div></div></div>` +
        `<button class="btn btn--primary" type="button" data-paction="remind">${remindLabel}</button>`;
    } else {
      pr.innerHTML = `<div class="card__title">Ваш режим</div><p class="about-text">Заполните расчёт на вкладке «Расчёт» — здесь появятся ваш выгодный режим и напоминания о сроках.</p>`;
    }
  }
  renderSavedCalcs();
  const pd = $('profileData');
  if (pd) {
    pd.innerHTML =
      `<div class="card__title">Мои данные</div>` +
      `<p class="about-text">Введённые цифры и сохранённые расчёты хранятся <b>только на этом устройстве</b> и не отправляются на сервер.</p>` +
      `<button class="btn btn--text" type="button" data-paction="clear-data">🗑 Очистить мои данные</button>`;
  }
}

// Делегированные клики во вкладке «Профиль» (контент рендерится динамически).
$('tab-profile')?.addEventListener('click', (e) => {
  const el = e.target.closest('[data-paction]');
  if (!el) return;
  const a = el.dataset.paction;
  if (a === 'buy') openPaywall();
  else if (a === 'remind') goToReminders();
  else if (a === 'save-calc') saveCurrentCalc();
  else if (a === 'load-calc') loadCalc(el.dataset.id);
  else if (a === 'del-calc') deleteCalc(el.dataset.id);
  else if (a === 'clear-data') clearMyData();
});

// --- Старт ---
restoreInputs();
applyProLock();
recalc();
verifyWebPro();
// Вход «Купить картой» с лендинга (?buy=1) → сразу открываем окно покупки.
if (new URLSearchParams(location.search).get('buy') === '1') { openPaywall(); }
