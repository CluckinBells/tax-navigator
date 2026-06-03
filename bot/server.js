// Бэкенд бота «Налоговый навигатор ИП 2026».
// Делает три вещи:
//   1. Отдаёт команду /start с кнопкой запуска Mini App.
//   2. Создаёт инвойс Telegram Stars и выдаёт invoice link для openInvoice().
//   3. Подтверждает оплату (pre_checkout + successful_payment) и помечает пользователя как Pro.
//
// Оплата идёт через Telegram Stars (XTR) — не нужен эквайринг и проверка ИП.
// Позже Stars можно заменить на рубли (ЮKassa) — поменяется только провайдер в инвойсе.
//
// Запуск:  BOT_TOKEN=xxx WEBAPP_URL=https://... node bot/server.js
// Зависимости: только встроенный http + fetch (Node 18+). Без npm-пакетов.

import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://example.com/webapp/index.html';
const PORT = process.env.PORT || 3000;
// Цена Pro в Telegram Stars (XTR). Ориентир: 1990 ₽ ≈ 1000 ⭐
// (курс Stars плавает — уточните актуальный в @PremiumBot и поменяйте PRO_PRICE_STARS).
// Pro — РАЗОВАЯ покупка, доступ навсегда (без подписки/продлений).
const PRO_PRICE_STARS = Number(process.env.PRO_PRICE_STARS || 1000);
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) {
  console.error('❌ Не задан BOT_TOKEN. Получите токен у @BotFather и запустите:');
  console.error('   BOT_TOKEN=xxx WEBAPP_URL=https://.../webapp/index.html node bot/server.js');
  process.exit(1);
}

// --- Хранилище Pro-статусов ---
// Для прода замените на БД (SQLite/Postgres). Здесь — простой JSON-файл.
// Pro — разовая покупка навсегда: храним просто список userId, кто оплатил.
const DB_PATH = new URL('./pro-users.json', import.meta.url);
let proUsers = new Set();
try {
  const raw = JSON.parse(readFileSync(DB_PATH, 'utf8'));
  // Совместимость со старым форматом (объект {id: дата} → берём ключи как бессрочный доступ).
  if (Array.isArray(raw)) proUsers = new Set(raw.map(String));
  else proUsers = new Set(Object.keys(raw));
} catch (_) {}
function saveDb() {
  try { writeFileSync(DB_PATH, JSON.stringify([...proUsers])); } catch (_) {}
}
function grantPro(userId) { proUsers.add(String(userId)); saveDb(); }
function isPro(userId) { return proUsers.has(String(userId)); }

// --- Telegram Bot API helper ---
async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// --- Проверка подписи initData из Mini App (важно для безопасности!) ---
// Гарантирует, что запрос реально пришёл из Telegram, а не подделан.
function verifyInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calcHash !== hash) return null;
    const user = JSON.parse(params.get('user') || '{}');
    return user;
  } catch (_) {
    return null;
  }
}

// --- HTTP-сервер: эндпоинты для Mini App + вебхук Telegram ---
const server = http.createServer(async (req, res) => {
  // CORS — чтобы Mini App с другого домена мог обращаться к бэкенду.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const body = await readBody(req);

  // 1) Mini App спрашивает: «я Pro?»
  if (req.url === '/me' && req.method === 'POST') {
    const user = verifyInitData(body.initData);
    if (!user) return json(res, 401, { error: 'bad initData' });
    return json(res, 200, { userId: user.id, isPro: isPro(user.id) });
  }

  // 2) Mini App просит ссылку на оплату Pro
  if (req.url === '/create-invoice' && req.method === 'POST') {
    const user = verifyInitData(body.initData);
    if (!user) return json(res, 401, { error: 'bad initData' });
    if (isPro(user.id)) return json(res, 200, { alreadyPro: true });

    const resp = await tg('createInvoiceLink', {
      title: 'Налоговый навигатор Pro',
      description: 'Разовый доступ навсегда: детальная разбивка, сценарии роста, точки перелома, черновик декларации УСН, налоговый календарь и PDF-отчёт.',
      payload: `pro_${user.id}_${Date.now()}`,
      currency: 'XTR', // Telegram Stars
      prices: [{ label: 'Pro-доступ (навсегда)', amount: PRO_PRICE_STARS }],
    });
    if (!resp.ok) return json(res, 500, { error: resp.description });
    return json(res, 200, { invoiceLink: resp.result });
  }

  // 3) Вебхук Telegram (обновления бота)
  if (req.url === `/webhook/${BOT_TOKEN}` && req.method === 'POST') {
    await handleUpdate(body);
    return json(res, 200, { ok: true });
  }

  json(res, 200, { service: 'tax-navigator-bot', ok: true });
});

// --- Обработка апдейтов Telegram ---
async function handleUpdate(update) {
  // /start — приветствие + кнопка запуска Mini App
  if (update.message?.text?.startsWith('/start')) {
    const chatId = update.message.chat.id;
    await tg('sendMessage', {
      chat_id: chatId,
      text: '👋 Это «Налоговый навигатор ИП 2026».\n\nСравните 6 налоговых режимов с учётом реформы НДС и узнайте, сколько можно сэкономить. Базовый расчёт — бесплатно.',
      reply_markup: {
        inline_keyboard: [[{ text: '🧮 Открыть калькулятор', web_app: { url: WEBAPP_URL } }]],
      },
    });
    return;
  }

  // pre_checkout — обязательно ответить в течение 10 секунд, иначе оплата отменится
  if (update.pre_checkout_query) {
    await tg('answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
    return;
  }

  // successful_payment — оплата прошла, выдаём Pro навсегда
  if (update.message?.successful_payment) {
    const userId = update.message.from.id;
    grantPro(userId);
    await tg('sendMessage', {
      chat_id: update.message.chat.id,
      text: '🎉 Pro активирован навсегда! Открыты детальная разбивка, сценарии роста, точки перелома, черновик декларации УСН, налоговый календарь и PDF-отчёт.',
      reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть Pro', web_app: { url: `${WEBAPP_URL}?pro=1` } }]] },
    });
    return;
  }
}

// --- утилиты ---
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, () => {
  console.log(`✅ Бот-бэкенд слушает порт ${PORT}`);
  console.log(`   Mini App: ${WEBAPP_URL}`);
  console.log(`   Цена Pro: ${PRO_PRICE_STARS} ⭐ (разовая покупка, навсегда)`);
  console.log(`\n   Не забудьте установить вебхук:`);
  console.log(`   curl "${API}/setWebhook?url=https://ВАШ_ДОМЕН/webhook/${BOT_TOKEN}"`);
});
