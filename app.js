// Живой демо-калькулятор на лендинге (бесплатный режим).
import { calculateAll } from './shared/engine.js?v=45';
import { formatMoney, formatPercent, parseMoney } from './shared/format.js?v=45';

const $ = (id) => document.getElementById(id);

// --- Подсказки к полям (для новичков) ---
// Тап по «?» открывает аккуратный поповер с объяснением.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.help');
  // Закрытие открытого поповера при клике вне его
  const open = document.querySelector('.help-pop');
  if (open && !e.target.closest('.help-pop') && !btn) { open.remove(); return; }
  if (!btn) return;
  e.preventDefault();
  if (open) open.remove();
  const pop = document.createElement('div');
  pop.className = 'help-pop';
  pop.innerHTML = `<button class="help-pop__x" aria-label="Закрыть">×</button><p>${btn.getAttribute('data-help') || ''}</p>`;
  btn.insertAdjacentElement('afterend', pop);
  pop.querySelector('.help-pop__x').addEventListener('click', () => pop.remove());
});

const els = {
  revenue: $('revenue'),
  expenses: $('expenses'),
  individualsShare: $('individualsShare'),
  indivOut: $('indivOut'),
  employees: $('employees'),
  ausnRegion: $('ausnRegion'),
  patentAvailable: $('patentAvailable'),
  patentCost: $('patentCost'),
  patentCostField: $('patentCostField'),
  resultHook: $('resultHook'),
  overpayNum: $('overpayNum'),
  resultBest: $('resultBest'),
  prolockSavings: $('prolockSavings'),
  prolockOverpay: $('prolockOverpay'),
  prolockHead: $('prolockHead'),
  bestPill: $('bestPill'),
  bestCard: $('bestCard'),
  compareList: $('compareList'),
  expenseWarn: $('expenseWarn'),
};

// Сохранение введённых данных на устройстве (localStorage) — между визитами.
// Это НЕ отправка на сервер: данные остаются в браузере пользователя.
const STORAGE_KEY = 'tn_inputs';

function saveInputs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      revenue: els.revenue.value,
      expenses: els.expenses.value,
      individualsShare: els.individualsShare.value,
      employees: els.employees.value,
      ausnRegion: els.ausnRegion.checked,
      patentAvailable: els.patentAvailable.checked,
      patentCost: els.patentCost.value,
    }));
  } catch (_) { /* приватный режим браузера — просто не сохраняем */ }
}

function restoreInputs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.revenue != null) els.revenue.value = s.revenue;
    if (s.expenses != null) els.expenses.value = s.expenses;
    if (s.individualsShare != null) { els.individualsShare.value = s.individualsShare; els.indivOut.textContent = s.individualsShare + '%'; }
    if (s.employees != null) els.employees.value = s.employees;
    if (typeof s.ausnRegion === 'boolean') els.ausnRegion.checked = s.ausnRegion;
    if (typeof s.patentAvailable === 'boolean') {
      els.patentAvailable.checked = s.patentAvailable;
      els.patentCostField.style.opacity = s.patentAvailable ? '1' : '.5';
    }
    if (s.patentCost != null) els.patentCost.value = s.patentCost;
  } catch (_) { /* битые данные — игнорируем */ }
}

// Красивое форматирование числовых полей с разделителями тысяч при вводе.
function attachMoneyInput(input) {
  input.addEventListener('input', () => {
    const caretFromEnd = input.value.length - input.selectionStart;
    const n = parseMoney(input.value);
    input.value = n ? n.toLocaleString('ru-RU') : '';
    const pos = Math.max(0, input.value.length - caretFromEnd);
    input.setSelectionRange(pos, pos);
    recalc();
  });
}
['revenue', 'expenses', 'patentCost'].forEach((k) => attachMoneyInput(els[k]));

els.individualsShare.addEventListener('input', () => {
  els.indivOut.textContent = els.individualsShare.value + '%';
  recalc();
});
['employees', 'ausnRegion', 'patentAvailable'].forEach((k) =>
  els[k].addEventListener('input', recalc)
);
els.patentAvailable.addEventListener('input', () => {
  els.patentCostField.style.opacity = els.patentAvailable.checked ? '1' : '.5';
});

function readInput() {
  return {
    revenue: parseMoney(els.revenue.value),
    expenses: parseMoney(els.expenses.value),
    individualsShare: Number(els.individualsShare.value) / 100,
    employees: Number(els.employees.value) || 0,
    ausnRegion: els.ausnRegion.checked,
    patentAvailable: els.patentAvailable.checked,
    patentCost: parseMoney(els.patentCost.value),
  };
}

function recalc() {
  const input = readInput();
  const res = calculateAll(input);

  // Предупреждение, если расходы больше выручки (частая опечатка).
  if (els.expenseWarn) els.expenseWarn.hidden = !(input.expenses > input.revenue && input.revenue > 0);

  // Сохраняем введённые данные на устройстве для следующего визита.
  saveInputs();

  // Карточка лучшего режима
  if (res.best) {
    els.bestPill.style.display = '';
    // Хук: личная переплата (loss-framing) — главный мотиватор. res.savings = разрыв лучший↔худший.
    if (res.savings > 0) {
      els.resultHook.style.display = '';
      els.overpayNum.textContent = formatMoney(res.savings);
      els.prolockSavings.textContent = formatMoney(res.savings);
      if (els.prolockOverpay) els.prolockOverpay.textContent = formatMoney(res.savings);
      if (els.prolockHead) els.prolockHead.innerHTML = 'Заберите свои <b>' + formatMoney(res.savings) + '</b> — весь план в Pro';
    } else {
      els.resultHook.style.display = 'none';
      els.prolockSavings.textContent = 'эту сумму';
      if (els.prolockOverpay) els.prolockOverpay.textContent = 'вашей переплаты';
      if (els.prolockHead) els.prolockHead.textContent = 'Полный план под ваш режим';
    }
    // Спокойно, ниже хука: выгодный режим и его нагрузка.
    const rate = res.effectiveRate != null ? ` · ${formatPercent(res.effectiveRate)} от выручки` : '';
    els.resultBest.innerHTML = `Выгоднее всего — <b>${res.best.name}</b>: ${formatMoney(res.best.total)} налогов в год${rate}`;
  } else {
    els.resultHook.style.display = 'none';
    els.resultBest.textContent = 'Нет доступных режимов — проверьте параметры.';
    els.prolockSavings.textContent = 'эту сумму';
    if (els.prolockHead) els.prolockHead.textContent = 'Полный план под ваш режим';
    els.bestPill.style.display = 'none';
  }

  // Список сравнения — сортируем: доступные по возрастанию налога, недоступные в конце
  const sorted = [...res.regimes].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.total - b.total;
  });
  const maxTotal = Math.max(1, ...res.regimes.filter((r) => r.available).map((r) => r.total));

  els.compareList.innerHTML = sorted.map((r) => {
    if (!r.available) {
      const why = (r.reasons && r.reasons.length)
        ? r.reasons.join(' • ')
        : 'Недоступен при ваших параметрах';
      return `<div class="crow crow--off" tabindex="0" title="${escapeAttr(why)}">
        <span class="crow__name">${r.name}</span>
        <span class="crow__na">недоступен <span class="crow__why" aria-hidden="true">?</span></span>
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

// Защита от поломки разметки/инъекций при подстановке текста причин.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// Тап/клик по недоступной строке раскрывает причину (работает и на мобильном,
// где :hover недоступен). Делегирование — один обработчик на весь список.
els.compareList.addEventListener('click', (e) => {
  const row = e.target.closest('.crow--off');
  if (row) row.classList.toggle('is-open');
});

// --- Старт ---
restoreInputs();
recalc();
