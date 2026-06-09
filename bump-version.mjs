// Бамп версии кеша (?v=N) на КЛИЕНТСКИХ ассетах и импортах — запускать перед каждым деплоем фронта.
// Зачем: GitHub Pages / браузер кешируют JS и CSS. Без смены ?v вернувшийся пользователь может
// получить старый код (включая старую налоговую математику после правки ставок).
//
// Файлы shared/*.js НАМЕРЕННО не трогаем: они грузятся и в Node (бот + тесты),
// где query-строка в импорте не нужна. Браузер всё равно перекачивает engine.js?v=N (логику)
// заново при бампе; params.js подтянется по ревалидации Pages (max-age=600).
//
// Запуск:  node bump-version.mjs   → найдёт текущий максимум ?v=N и поднимет на 1 во всех файлах.

import { readFileSync, writeFileSync } from 'node:fs';

const FILES = ['index.html', 'webapp/index.html', 'app.js', 'webapp/app.js', 'webapp/print.html'];

// 1) Находим текущую максимальную версию среди всех файлов.
let max = 0;
for (const f of FILES) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/\?v=(\d+)/g)) max = Math.max(max, Number(m[1]));
}
const next = max + 1;

// 2) Проставляем next во все вхождения ?v=N.
let changed = 0;
for (const f of FILES) {
  const text = readFileSync(f, 'utf8');
  const out = text.replace(/\?v=\d+/g, `?v=${next}`);
  if (out !== text) { writeFileSync(f, out); changed++; }
}

console.log(`Версия кеша → ?v=${next} (обновлено файлов: ${changed} из ${FILES.length})`);
