// Построение HTML-документа «Налоговый отчёт» для печати / сохранения в PDF.
// Чистая функция: вход — input (показатели) и res (результат calculateAll),
// выход — самодостаточный HTML-документ (встроенные стили + SVG-логотип).
// Используется страницей webapp/print.html, которая открывается в НАСТОЯЩЕМ браузере
// (через tg.openLink), где печать работает — в отличие от WebView Telegram.

import { breakevenSweep } from './engine.js';
import { formatMoney, formatPercent, formatShort } from './format.js';

export function buildReportHtml(input, res) {
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

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Налоговый отчёт ИП — ${today}</title>
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
      <div class="meta">Отчёт от ${today}</div></div>

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
}
