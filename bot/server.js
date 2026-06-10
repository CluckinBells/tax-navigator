// Бэкенд бота «Налоговый навигатор ИП 2026».
// Делает три вещи:
//   1. Отдаёт команду /start с кнопкой запуска Mini App.
//   2. Создаёт инвойс ЮKassa (рубли картой) и выдаёт invoice link для openInvoice().
//   3. Подтверждает оплату (pre_checkout + successful_payment) и выдаёт Pro навсегда.
//
// Оплата — через ЮKassa прямо в Telegram (рубли картой/SberPay/ЮMoney, чек по 54-ФЗ).
// Платёжный токен берётся в @BotFather (Payments → ЮKassa). Магазин ЮKassa должен быть
// зарегистрирован «для Telegram-бота» (не для сайта). Один бот = один магазин.
//
// Запуск:  BOT_TOKEN=xxx PROVIDER_TOKEN=xxx WEBAPP_URL=https://... node bot/server.js
// Зависимости: только встроенный http + fetch (Node 18+). Без npm-пакетов.

import http from 'node:http';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import crypto from 'node:crypto';
import { nextDeadline } from '../shared/engine.js';
import { dueReminders, daysLeftPhrase, formatDateRu } from '../shared/reminders.js';
import { recordStart, formatSourceStats } from '../shared/sources.js';
import { createPending, markPaid, isPaid, markClaimed, isClaimed } from '../shared/webpro.js';

// .trim() — на случай, если в переменную окружения (например, на Amvera при вставке)
// попал лишний пробел/таб/перенос строки. Без этого Telegram отклоняет web_app-кнопку
// с ошибкой "Unsupported URL protocol" (видит протокол как '\thttps').
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const WEBAPP_URL = (process.env.WEBAPP_URL || 'https://example.com/webapp/index.html').trim();
// Явная ссылка на политику конфиденциальности — не выводим из WEBAPP_URL, чтобы не зависеть
// от его формата/домена. По умолчанию — наш домен; можно переопределить переменной окружения.
const PRIVACY_URL = (process.env.PRIVACY_URL || 'https://navnalog.ru/privacy.html').trim();
// Прямая ссылка на Mini App (t.me/бот/коротыш) — для кнопок в напоминаниях.
// url-кнопка надёжнее web_app-кнопки и открывает приложение из любого сообщения.
const MINIAPP_LINK = (process.env.MINIAPP_LINK || 'https://t.me/taxes_navigator_bot/calc').trim();
// Порт: Amvera ожидает 80 (см. amvera.yml containerPort). Локально можно задать PORT.
const PORT = process.env.PORT || 80;
// ID администратора (ваш Telegram ID) — кому доступны команды управления Pro.
// Через запятую можно указать несколько. Узнать свой ID: напишите боту @userinfobot.
const ADMIN_IDS = (process.env.ADMIN_IDS || '702308050').split(',').map((s) => s.trim()).filter(Boolean);
const isAdmin = (userId) => ADMIN_IDS.includes(String(userId));

// --- Оплата через ЮKassa (рубли картой прямо в Telegram) ---
// PROVIDER_TOKEN — «платёжный токен» из @BotFather (Bot Settings → Payments → ЮKassa).
// Это НЕ секретный ключ из ЛК ЮKassa — отдельный токен для бота, выдаётся при привязке магазина.
const PROVIDER_TOKEN = (process.env.PROVIDER_TOKEN || '').trim();
// Цена Pro в рублях. Pro — РАЗОВАЯ покупка, доступ навсегда (без подписки/продлений).
const PRO_PRICE_RUB = Number(process.env.PRO_PRICE_RUB || 990);
// «Обычная» цена-якорь для зачёркивания в тексте (промо «990 вместо 1990»). Только показ.
const PRO_PRICE_ORIGINAL_RUB = Number(process.env.PRO_PRICE_ORIGINAL_RUB || 1990);
const PRICE_LABEL = PRO_PRICE_ORIGINAL_RUB > PRO_PRICE_RUB
  ? `${PRO_PRICE_RUB} ₽ (вместо ${PRO_PRICE_ORIGINAL_RUB} ₽, цена запуска)`
  : `${PRO_PRICE_RUB} ₽`;
// Ставка НДС для чека 54-ФЗ: 1 = без НДС (для ИП на УСН/НПД). См. ЛК ЮKassa.
const VAT_CODE = Number(process.env.VAT_CODE || 1);
// Секрет аутентификации вебхука ЮKassa (refund). ЮKassa должна слать на URL с ?s=<этот секрет>.
// Если не задан — вебхук ЮKassa отклоняется (авто-revoke при возврате выключен; возврат можно
// оформить вручную через /admin). Защита от подделки refund→revokePro.
const YOOKASSA_WEBHOOK_SECRET = (process.env.YOOKASSA_WEBHOOK_SECRET || '').trim();
// --- Веб-оплата ЮKassa через API (оплата картой на САЙТЕ, без Telegram). Ключи из ЛК ЮKassa. ---
const YOOKASSA_SHOP_ID = (process.env.YOOKASSA_SHOP_ID || '').trim();
const YOOKASSA_SECRET_KEY = (process.env.YOOKASSA_SECRET_KEY || '').trim();
// Базовый адрес сайта для return_url после оплаты (и claim-ссылок). Без хвостового слэша.
const SITE_URL = (process.env.SITE_URL || 'https://navnalog.ru').trim().replace(/\/$/, '');
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
// Секрет верификации вебхука: Telegram возвращает его в заголовке X-Telegram-Bot-Api-Secret-Token.
// Детерминированно выводим из BOT_TOKEN — отдельная env-переменная не нужна; бот сам ставит его
// в setWebhook на старте (см. listen ниже). Защита от подделки вебхук-запросов.
const WEBHOOK_SECRET = crypto.createHash('sha256').update(BOT_TOKEN + ':webhook-secret').digest('hex').slice(0, 48);
// Таймаут вызовов Telegram API (мс) — чтобы запрос не висел бесконечно (важно для pre_checkout 10с).
const TG_TIMEOUT_MS = Number(process.env.TG_TIMEOUT_MS || 12000);
// Применён ли secret_token к вебхуку (ставится при успешном setWebhook на старте). Пока false
// (или setWebhook не удался) — заголовок НЕ требуем, чтобы случайно не заблокировать бота.
let webhookSecretApplied = false;

// --- Лимиты и анти-абуз (батч безопасности) ---
// Лимит размера тела запроса (защита от OOM/DoS): апдейты Telegram и наши POST много меньше.
const MAX_BODY = Number(process.env.MAX_BODY || 64 * 1024);
// TTL подписи initData (сек): защита от воспроизведения перехваченной строки. Mini App шлёт свежую при каждом открытии.
const INITDATA_TTL_SEC = Number(process.env.INITDATA_TTL_SEC || 86400);
// Анти-абуз веб-оплаты: не больше N созданий платежа с одного IP за окно (бережёт ЮKassa и web-pro.json).
const WEBPAY_MAX = Number(process.env.WEBPAY_MAX || 20);
const WEBPAY_WINDOW_MS = Number(process.env.WEBPAY_WINDOW_MS || 10 * 60 * 1000);
// Сколько дней claim-ссылка валидна после оплаты (ограничивает срок жизни утёкшего токена).
const CLAIM_TTL_DAYS = Number(process.env.CLAIM_TTL_DAYS || 14);

// Отказоустойчивость: один плохой апдейт/промис не должен ронять процесс (иначе краш-петля —
// Telegram переотправляет тот же апдейт снова и снова).
process.on('unhandledRejection', (e) => console.log('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.log('[uncaughtException]', e?.message || e));

if (!BOT_TOKEN) {
  console.error('❌ Не задан BOT_TOKEN. Получите токен у @BotFather и запустите:');
  console.error('   BOT_TOKEN=xxx PROVIDER_TOKEN=xxx WEBAPP_URL=https://... node bot/server.js');
  process.exit(1);
}
if (!PROVIDER_TOKEN) {
  console.warn('⚠️  Не задан PROVIDER_TOKEN — оплата ЮKassa не заработает.');
  console.warn('   Получите его в @BotFather: /mybots → бот → Payments → ЮKassa → Live token.');
}

// --- Хранилище Pro-статусов ---
// Для прода замените на БД (SQLite/Postgres). Здесь — простой JSON-файл.
// Pro — разовая покупка навсегда: храним просто список userId, кто оплатил.
// DATA_DIR — на Amvera монтируется постоянный том (/data), чтобы список не терялся
// при перезапусках. Локально (без переменной) пишем рядом с server.js.
const DB_PATH = process.env.DATA_DIR
  ? new URL('pro-users.json', `file://${process.env.DATA_DIR.replace(/\/?$/, '/')}`)
  : new URL('./pro-users.json', import.meta.url);
let proUsers = new Set();
try {
  const raw = JSON.parse(readFileSync(DB_PATH, 'utf8'));
  // Совместимость со старым форматом (объект {id: дата} → берём ключи как бессрочный доступ).
  if (Array.isArray(raw)) proUsers = new Set(raw.map(String));
  else proUsers = new Set(Object.keys(raw));
} catch (e) { if (e.code !== 'ENOENT') console.log('[store] pro-users.json не прочитан (начинаю с пустого):', e.message); }
// Карта «платёж ЮKassa → userId» — чтобы при возврате знать, у кого забрать Pro.
// ЮKassa в уведомлении о возврате присылает id платежа, а не Telegram userId.
const PAY_MAP_PATH = process.env.DATA_DIR
  ? new URL('payments.json', `file://${process.env.DATA_DIR.replace(/\/?$/, '/')}`)
  : new URL('./payments.json', import.meta.url);
let payToUser = {};
try { payToUser = JSON.parse(readFileSync(PAY_MAP_PATH, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.log('[store] payments.json не прочитан:', e.message); }

// Атомарная запись JSON: пишем во временный файл и переименовываем (rename атомарен в пределах
// одной ФС). Защищает от повреждения файла при падении/рестарте посреди записи (потеря оплат).
function writeJsonAtomic(pathUrl, value) {
  try {
    const tmp = new URL(pathUrl.href + '.tmp');
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, pathUrl);
  } catch (e) { console.log('[store] ошибка записи', String(pathUrl).split('/').pop(), e?.message || e); }
}
function saveDb() { writeJsonAtomic(DB_PATH, [...proUsers]); }
function savePayMap() { writeJsonAtomic(PAY_MAP_PATH, payToUser); }
function grantPro(userId) { proUsers.add(String(userId)); saveDb(); }
function revokePro(userId) { proUsers.delete(String(userId)); saveDb(); }
function isPro(userId) { return proUsers.has(String(userId)); }
function rememberPayment(paymentId, userId) {
  if (paymentId) { payToUser[String(paymentId)] = String(userId); savePayMap(); }
}

// --- Хранилище подписок на напоминания о сроках ---
// reminders.json: { userId: { regime, chatId, since, sent: { 'дата:стадия': true } } }
// regime — представитель семьи режимов (usn6/psn/ausn8): даты внутри семьи одинаковы.
const REM_PATH = process.env.DATA_DIR
  ? new URL('reminders.json', `file://${process.env.DATA_DIR.replace(/\/?$/, '/')}`)
  : new URL('./reminders.json', import.meta.url);
let reminders = {};
try { reminders = JSON.parse(readFileSync(REM_PATH, 'utf8')); } catch (_) {}
function saveReminders() { writeJsonAtomic(REM_PATH, reminders); }
const isoToday = () => new Date().toISOString().slice(0, 10);
function subscribeReminders(userId, chatId, regime) {
  const id = String(userId);
  const prev = reminders[id] || {};
  reminders[id] = { regime, chatId: String(chatId), since: prev.since || isoToday(), sent: prev.sent || {} };
  saveReminders();
}
function unsubscribeReminders(userId) { delete reminders[String(userId)]; saveReminders(); }

// --- Хранилище источников переходов (start-метки) ---
// sources.json: { sources: { <метка>: { starts, users, first, last } }, seen: { <userId>: <первая метка> } }
// Считаем, откуда люди приходят в бота (?start=tg_seller / site / nds / ...). Логика — в shared/sources.js.
const SRC_PATH = process.env.DATA_DIR
  ? new URL('sources.json', `file://${process.env.DATA_DIR.replace(/\/?$/, '/')}`)
  : new URL('./sources.json', import.meta.url);
let sourceStats = { sources: {}, seen: {} };
try {
  const s = JSON.parse(readFileSync(SRC_PATH, 'utf8'));
  if (s && s.sources && s.seen) sourceStats = s;
} catch (_) {}
function saveSources() { writeJsonAtomic(SRC_PATH, sourceStats); }

// --- Хранилище веб-оплат Pro (покупки с сайта через ЮKassa API) ---
// web-pro.json: { <token>: { paid, paymentId, amount, createdAt, paidAt, claimedBy } }. Логика — shared/webpro.js.
const WEBPRO_PATH = process.env.DATA_DIR
  ? new URL('web-pro.json', `file://${process.env.DATA_DIR.replace(/\/?$/, '/')}`)
  : new URL('./web-pro.json', import.meta.url);
let webPro = {};
try { webPro = JSON.parse(readFileSync(WEBPRO_PATH, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.log('[store] web-pro.json не прочитан:', e.message); }
function saveWebPro() { writeJsonAtomic(WEBPRO_PATH, webPro); }

// --- Анти-абуз веб-оплаты: лимит по IP + уборка протухших неоплаченных pending ---
const webPayHits = new Map();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
}
function webPayRateLimited(ip) {
  const now = Date.now();
  const arr = (webPayHits.get(ip) || []).filter((t) => now - t < WEBPAY_WINDOW_MS);
  if (arr.length >= WEBPAY_MAX) { webPayHits.set(ip, arr); return true; }
  arr.push(now); webPayHits.set(ip, arr); return false;
}
function cleanupWebPro() {
  const cutoff = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  let changed = false;
  for (const [t, rec] of Object.entries(webPro)) {
    if (!rec.paid && !rec.claimedBy && (rec.createdAt || '0000-00-00') < cutoff) { delete webPro[t]; changed = true; }
  }
  if (changed) saveWebPro();
}

// Создание платежа через API ЮKassa (Basic-auth shopId:secretKey). Возвращает {ok,id,confirmationUrl,error}.
async function yookassaCreatePayment({ amount, email, token }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
    const payload = {
      amount: { value: amount, currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: `${SITE_URL}/webapp/?paid=${token}` },
      description: 'Налоговый навигатор Pro (разовый доступ)',
      metadata: { kind: 'web_pro', token },
    };
    // Чек 54-ФЗ формируем, только если передан email; иначе чек настраивается на стороне ЮKassa.
    if (email) {
      payload.receipt = {
        customer: { email },
        items: [{ description: 'Налоговый навигатор Pro', quantity: '1.00', amount: { value: amount, currency: 'RUB' }, vat_code: VAT_CODE, payment_mode: 'full_payment', payment_subject: 'service' }],
      };
    }
    const r = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Idempotence-Key': crypto.randomUUID(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.confirmation?.confirmation_url) return { ok: false, error: data?.description || `http ${r.status}` };
    return { ok: true, id: data.id, confirmationUrl: data.confirmation.confirmation_url };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

// Запрос статуса платежа у ЮKassa по id (надёжный источник правды, не зависит от вебхука).
async function yookassaGetPayment(paymentId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
    const r = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
      headers: { 'Authorization': `Basic ${auth}` }, signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: `http ${r.status}` };
    return { ok: true, status: data.status };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

// Семья режима (для кнопок выбора) → представитель id; и человекочитаемые названия.
const REM_FAMILY = { usn: 'usn6', psn: 'psn', ausn: 'ausn8' };
const REGIME_LABELS = { usn6: 'УСН', usn15: 'УСН', psn: 'Патент (ПСН)', ausn8: 'АУСН', ausn20: 'АУСН', npd: 'НПД' };

// --- Telegram Bot API helper ---
async function tg(method, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TG_TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await res.json();
  } catch (e) {
    console.log(`[tg] ${method}:`, e?.name === 'AbortError' ? 'таймаут' : (e?.message || e));
    return { ok: false, description: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// --- Утилиты безопасности ---
// Сравнение секретов/хешей за константное время (защита от тайминг-атак). false при разной длине.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}
// Маскирование секрета/токена для логов (не пишем целиком в логи Amvera).
const redact = (s) => { const v = String(s || ''); return v.length > 8 ? v.slice(0, 6) + '…' : '***'; };

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
    if (!hash || !safeEqual(calcHash, hash)) return null;
    // Свежесть initData: отклоняем слишком старую (защита от воспроизведения перехваченной строки).
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || (Date.now() / 1000 - authDate) > INITDATA_TTL_SEC) return null;
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

  // 2) Mini App просит ссылку на оплату Pro (ЮKassa, рубли картой)
  if (req.url === '/create-invoice' && req.method === 'POST') {
    console.log('[create-invoice] запрос получен, initData длина:', (body.initData || '').length);
    const user = verifyInitData(body.initData);
    if (!user) { console.log('[create-invoice] ОТКАЗ: bad initData'); return json(res, 401, { error: 'bad initData' }); }
    console.log('[create-invoice] пользователь:', user.id);
    if (isPro(user.id)) return json(res, 200, { alreadyPro: true });

    const title = 'Налоговый навигатор Pro';
    const description = 'Разовый доступ навсегда: детальная разбивка, сценарии роста, точки перелома, черновик декларации УСН, налоговый календарь и PDF-отчёт.';

    const resp = await tg('createInvoiceLink', {
      title,
      description,
      payload: `pro_${user.id}_${Date.now()}`,
      provider_token: PROVIDER_TOKEN,
      currency: 'RUB',
      // сумма в КОПЕЙКАХ (требование Telegram Payments API)
      prices: [{ label: 'Pro-доступ (навсегда)', amount: PRO_PRICE_RUB * 100 }],
      // для чека 54-ФЗ ЮKassa требует email/телефон плательщика
      need_email: true,
      send_email_to_provider: true,
      // данные чека для ЮKassa: сумма в РУБЛЯХ (строкой)
      provider_data: JSON.stringify({
        receipt: {
          items: [{
            description: title,
            quantity: '1.00',
            amount: { value: PRO_PRICE_RUB.toFixed(2), currency: 'RUB' },
            vat_code: VAT_CODE,
            payment_mode: 'full_payment',
            payment_subject: 'service',
          }],
        },
      }),
    });
    console.log('[create-invoice] ответ Telegram:', JSON.stringify(resp).slice(0, 300));
    if (!resp.ok) return json(res, 500, { error: resp.description || 'createInvoiceLink failed' });
    return json(res, 200, { invoiceLink: resp.result });
  }

  // 2b) Сайт просит создать веб-платёж ЮKassa (оплата картой на сайте, без Telegram).
  if (req.url === '/web/create-payment' && req.method === 'POST') {
    if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) return json(res, 503, { error: 'веб-оплата не настроена' });
    if (webPayRateLimited(clientIp(req))) return json(res, 429, { error: 'слишком много запросов, попробуйте позже' });
    cleanupWebPro();
    const email = String(body.email || '').trim(); // опционально (для чека 54-ФЗ); без него чек на стороне ЮKassa
    const token = crypto.randomBytes(16).toString('hex');
    const yk = await yookassaCreatePayment({ amount: PRO_PRICE_RUB.toFixed(2), email, token });
    if (!yk.ok) { console.log('[web-pay] ЮKassa ошибка:', yk.error); return json(res, 502, { error: 'не удалось создать платёж' }); }
    webPro = createPending(webPro, token, { paymentId: yk.id, amount: PRO_PRICE_RUB * 100, createdAt: isoToday() });
    saveWebPro();
    return json(res, 200, { confirmationUrl: yk.confirmationUrl });
  }

  // 2c) Сайт спрашивает: «эта покупка (token) оплачена?» — источник правды о веб-Pro.
  if (req.url === '/web/pro' && req.method === 'POST') {
    const token = String(body.token || '').trim();
    if (isPaid(webPro, token)) return json(res, 200, { isPro: true });
    // Локально не помечено (вебхук мог не дойти) — спрашиваем статус платежа напрямую у ЮKassa.
    const rec = webPro[token];
    if (rec && rec.paymentId && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY) {
      const p = await yookassaGetPayment(rec.paymentId);
      if (p.ok && p.status === 'succeeded') {
        webPro = markPaid(webPro, token, rec.paymentId, isoToday());
        saveWebPro();
        console.log('[web-pay] подтверждено через API ЮKassa: token', redact(token), 'payment', rec.paymentId);
        return json(res, 200, { isPro: true });
      }
    }
    return json(res, 200, { isPro: false });
  }

  // 3) Вебхук Telegram (обновления бота)
  if (req.url === `/webhook/${BOT_TOKEN}` && req.method === 'POST') {
    // Проверяем, что запрос реально от Telegram (secret_token). Защита от подделки апдейтов.
    // Требуем заголовок только когда секрет точно применён (fail-safe против самоблокировки).
    if (webhookSecretApplied && !safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', WEBHOOK_SECRET)) {
      return json(res, 403, { ok: false });
    }
    try { await handleUpdate(body); }
    catch (e) { console.log('[update] ошибка обработки:', e?.message || e); }
    return json(res, 200, { ok: true }); // всегда 200, иначе Telegram завалит ретраями
  }

  // 4) Вебхук ЮKassa: уведомление о ВОЗВРАТЕ → автоматически забираем Pro.
  // Настраивается в ЛК ЮKassa (HTTP-уведомления), событие refund.succeeded.
  if (req.method === 'POST' && (req.url === '/yookassa-webhook' || req.url.startsWith('/yookassa-webhook?'))) {
    // Аутентификация: ЮKassa шлёт на URL с секретом (?s=<YOOKASSA_WEBHOOK_SECRET>). Без заданного
    // секрета или при несовпадении — отклоняем (иначе любой POST мог снять Pro у пользователя).
    const provided = (() => { const i = req.url.indexOf('?s='); return i >= 0 ? decodeURIComponent(req.url.slice(i + 3).split('&')[0]) : (req.headers['x-webhook-secret'] || ''); })();
    if (!YOOKASSA_WEBHOOK_SECRET || !safeEqual(provided, YOOKASSA_WEBHOOK_SECRET)) {
      console.log('[yookassa-webhook] отклонён: неверный или отсутствующий секрет');
      return json(res, 403, { ok: false });
    }
    try {
      const event = body?.event;
      const obj = body?.object || {};
      console.log('[yookassa-webhook] событие:', event, 'платёж:', obj.payment_id || obj.id);
      if (event === 'refund.succeeded') {
        // У объекта возврата есть payment_id (id исходного платежа).
        const paymentId = obj.payment_id;
        const userId = paymentId ? payToUser[String(paymentId)] : null;
        if (userId) {
          revokePro(userId);
          console.log('[yookassa-webhook] возврат → Pro снят у userId', userId);
          // уведомим пользователя в чате (необязательно, но вежливо)
          try {
            await tg('sendMessage', {
              chat_id: userId,
              text: 'Возврат по вашей покупке Pro обработан. Доступ к Pro-функциям отключён. Если это ошибка — напишите нам.',
            });
          } catch (_) {}
        } else {
          console.log('[yookassa-webhook] возврат, но пользователь не найден по платежу', paymentId);
        }
      }
      if (event === 'payment.succeeded') {
        // Веб-оплата на сайте подтверждена. token у нас в metadata — помечаем покупку оплаченной (идемпотентно).
        const token = obj?.metadata?.token;
        if (token && webPro[token]) {
          webPro = markPaid(webPro, token, obj.id, isoToday());
          saveWebPro();
          console.log('[web-pay] оплачено: token', redact(token), 'payment', obj.id);
        } else {
          console.log('[web-pay] payment.succeeded без известного token:', redact(token));
        }
      }
    } catch (e) {
      console.log('[yookassa-webhook] ошибка обработки:', e?.message);
    }
    // ЮKassa ждёт 200, иначе будет повторять уведомление.
    return json(res, 200, { ok: true });
  }

  json(res, 200, { service: 'tax-navigator-bot', ok: true, build: '2026-06-10-gh12' });
});

// --- Главное меню бота ---
const MENU_TEXT =
  '👋 «Налоговый навигатор ИП 2026»\n\n' +
  'Сравните 6 налоговых режимов с учётом реформы НДС и узнайте, сколько можно сэкономить. Базовый расчёт — бесплатно.\n\n' +
  'Выберите раздел: 👇';

const MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: '🧮 Открыть калькулятор', web_app: { url: WEBAPP_URL } }],
    [{ text: `💳 Купить Pro — ${PRO_PRICE_RUB} ₽ навсегда`, callback_data: 'buy_pro' }],
    [{ text: '❓ Как это работает', callback_data: 'how' }, { text: '💎 Что даёт Pro', callback_data: 'pro' }],
    [{ text: '📅 Налоговые сроки 2026', callback_data: 'dates' }, { text: '🔔 Напоминания', callback_data: 'reminders' }],
    [{ text: '🛡️ О сервисе и контакты', callback_data: 'about' }],
  ],
};

// Кнопка «назад в меню» для экранов-разделов.
const BACK_KEYBOARD = { inline_keyboard: [[{ text: '← Назад в меню', callback_data: 'menu' }]] };

// Отправка инвойса ЮKassa прямо в чат бота (кнопка «Купить Pro»). Те же параметры, что и
// в Mini App (/create-invoice). Оплата завершается через pre_checkout + successful_payment.
async function sendProInvoice(chatId, userId) {
  if (isPro(userId)) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '✅ У вас уже есть Pro — доступ навсегда. Откройте калькулятор, все функции активны.',
      reply_markup: { inline_keyboard: [
        [{ text: '🚀 Открыть Pro', web_app: { url: WEBAPP_URL } }],
        [{ text: '← В меню', callback_data: 'menu' }],
      ] },
    });
    return;
  }
  if (!PROVIDER_TOKEN) {
    await tg('sendMessage', { chat_id: chatId, text: 'Оплата временно недоступна, попробуйте позже.' });
    return;
  }
  const r = await tg('sendInvoice', {
    chat_id: chatId,
    title: 'Налоговый навигатор Pro',
    description: 'Разовый доступ навсегда: детальная разбивка, сценарии роста, точки перелома, черновик декларации УСН, налоговый календарь, напоминания и PDF-отчёт.',
    payload: `pro_${userId}_${Date.now()}`,
    provider_token: PROVIDER_TOKEN,
    currency: 'RUB',
    prices: [{ label: 'Pro-доступ (навсегда)', amount: PRO_PRICE_RUB * 100 }],
    need_email: true,
    send_email_to_provider: true,
    provider_data: JSON.stringify({
      receipt: {
        items: [{
          description: 'Налоговый навигатор Pro',
          quantity: '1.00',
          amount: { value: PRO_PRICE_RUB.toFixed(2), currency: 'RUB' },
          vat_code: VAT_CODE,
          payment_mode: 'full_payment',
          payment_subject: 'service',
        }],
      },
    }),
  });
  if (!r.ok) {
    console.log('[buy_pro] sendInvoice ошибка:', JSON.stringify(r).slice(0, 300));
    await tg('sendMessage', { chat_id: chatId, text: 'Не удалось открыть оплату. Попробуйте ещё раз чуть позже.' });
  }
}

// Тексты разделов меню.
const SECTIONS = {
  how:
    '❓ <b>Как это работает</b>\n\n' +
    'Откройте калькулятор, введите выручку и расходы за год — сервис сравнит 6 режимов налогообложения (НПД, УСН 6%, УСН 15%, ПСН, АУСН) и покажет самый выгодный.\n\n' +
    'Возле каждого поля есть подсказка «?» — если что-то непонятно, нажмите её. Заполнять нужно всего 2 главных поля: выручку и расходы.\n\n' +
    'Расчёт идёт прямо на вашем устройстве — цифры никуда не передаются.',
  pro:
    `💎 <b>Что даёт Pro</b> — ${PRICE_LABEL}, разово, навсегда\n\n` +
    '🧭 Личная рекомендация словами: что выбрать и почему\n' +
    '📊 Разбивка нагрузки с графиками (налог, взносы, НДС)\n' +
    '📈 Сценарии роста и график налоговой кривой\n' +
    '🎯 Точки перелома — когда менять режим\n' +
    '📄 PDF-отчёт с логотипом для бухгалтера\n' +
    '📑 Черновик декларации УСН (КНД 1152017)\n' +
    '📅 Налоговый календарь под ваш режим\n' +
    '💰 «Сколько отложить»: налоговая подушка под ваш режим\n' +
    '🔔 Напоминания о сроках в Telegram под ваш режим\n\n' +
    'Оформить можно прямо в калькуляторе — откройте его и нажмите на любой Pro-раздел.',
  dates:
    '📅 <b>Ключевые налоговые сроки 2026</b> (для ИП)\n\n' +
    '<b>УСН:</b>\n' +
    '• 28 апр — аванс за I квартал\n' +
    '• 28 июл — аванс за полугодие\n' +
    '• 28 окт — аванс за 9 месяцев\n' +
    '• 27 апр — декларация УСН за 2025\n\n' +
    '<b>Страховые взносы ИП:</b>\n' +
    '• 1 июл — 1% с дохода свыше 300 тыс. за 2025\n' +
    '• 28 дек — фиксированные взносы за 2026 (57 390 ₽)\n\n' +
    '<b>Патент:</b> 1/3 в начале срока, остальное — к концу.\n\n' +
    'В Pro есть персональный календарь под ваш режим с напоминаниями о ближайших датах.',
  about:
    '🛡️ <b>О сервисе</b>\n\n' +
    '«Налоговый навигатор ИП 2026» — сервис для сравнения налоговых режимов ИП с учётом реформы НДС 2026.\n\n' +
    'Расчёт носит справочный характер и не заменяет консультацию бухгалтера.\n\n' +
    'По вопросам и обращениям: filimonov.filimonov05@mail.ru\n\n' +
    'Политика конфиденциальности: ' + PRIVACY_URL,
};

// --- Экраны раздела «Напоминания» (возвращают { text, keyboard }) ---
function remindersPicker() {
  return {
    text:
      '🔔 <b>Напоминания о налоговых сроках</b>\n\n' +
      'Выберите ваш режим — и бот заранее напомнит о платежах и отчётности: за неделю, за 3 дня, за день и в день срока.\n\n' +
      'Какой у вас налоговый режим?\n\n' +
      '<i>На НПД отдельных напоминаний нет: налог начисляет ФНС ежемесячно в приложении «Мой налог» (оплата до 28-го числа).</i>',
    keyboard: { inline_keyboard: [
      [{ text: 'УСН (Доходы / Д-Р)', callback_data: 'rem_set_usn' }],
      [{ text: 'Патент (ПСН)', callback_data: 'rem_set_psn' }],
      [{ text: 'АУСН', callback_data: 'rem_set_ausn' }],
      [{ text: '← Назад в меню', callback_data: 'menu' }],
    ] },
  };
}
function nextDeadlineLine(regime) {
  const next = nextDeadline(regime, new Date());
  if (!next) return 'Ближайших сроков в этом году не нашлось.';
  return `Ближайший срок: <b>${next.title}</b> — ${daysLeftPhrase(next.daysLeft)} (${formatDateRu(next.date)}).`;
}
function remindersStatus(userId) {
  const sub = reminders[String(userId)];
  if (!sub || !sub.regime) return remindersPicker();
  return {
    text:
      '🔔 <b>Напоминания включены</b>\n' +
      `Режим: <b>${REGIME_LABELS[sub.regime] || sub.regime}</b>\n\n` +
      nextDeadlineLine(sub.regime) + '\n\n' +
      'Напишу заранее: за 7, за 3, за 1 день и в день срока.',
    keyboard: { inline_keyboard: [
      [{ text: '🔄 Сменить режим', callback_data: 'reminders_pick' }],
      [{ text: '🔕 Выключить напоминания', callback_data: 'rem_off' }],
      [{ text: '← Назад в меню', callback_data: 'menu' }],
    ] },
  };
}
function remindersConfirm(userId) {
  const sub = reminders[String(userId)];
  return {
    text:
      `✅ Готово! Напоминания включены для режима <b>${REGIME_LABELS[sub.regime] || sub.regime}</b>.\n\n` +
      nextDeadlineLine(sub.regime) + '\n\n' +
      'Буду писать заранее: за 7, за 3, за 1 день и в день срока. Выключить можно в любой момент.',
    keyboard: { inline_keyboard: [
      [{ text: '🔕 Выключить', callback_data: 'rem_off' }],
      [{ text: '← Назад в меню', callback_data: 'menu' }],
    ] },
  };
}
const remindersOff = {
  text: '🔕 Напоминания выключены. Включить снова можно в меню в любой момент.',
  keyboard: { inline_keyboard: [[{ text: '← Назад в меню', callback_data: 'menu' }]] },
};
// Экран-апселл для тех, у кого нет Pro: напоминания — часть Pro.
const remindersUpsell = {
  text:
    '🔔 <b>Напоминания о сроках — в Pro</b>\n\n' +
    'Бот будет писать заранее о каждом налоговом сроке под ваш режим — за неделю, за 3 дня, за день и в день платежа. Чтобы не держать даты в голове и не платить пени.\n\n' +
    'Это часть Pro (разовая покупка, навсегда) — вместе с детальным разбором, сценариями, точками перелома, черновиком декларации и календарём.\n\n' +
    'Оформить можно прямо в калькуляторе — откройте его и нажмите на любой Pro-раздел.',
  keyboard: { inline_keyboard: [
    [{ text: '🧮 Открыть калькулятор', url: MINIAPP_LINK }],
    [{ text: '← Назад в меню', callback_data: 'menu' }],
  ] },
};

// --- Обработка апдейтов Telegram ---
async function handleUpdate(update) {
  // Лог входящего апдейта (что прислал Telegram) — для диагностики.
  console.log('[update] тип:', update.callback_query ? 'callback' : (update.message?.text || update.message?.successful_payment ? 'message' : 'other'),
              update.message?.text ? '| текст: ' + update.message.text.slice(0, 30) : '');

  // Нажатие inline-кнопки меню (callback_query)
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const msgId = cq.message?.message_id;
    const userId = cq.from?.id;
    const dataKey = cq.data || '';
    // Отвечаем Telegram, что нажатие принято (убирает «часики» на кнопке).
    await tg('answerCallbackQuery', { callback_query_id: cq.id });

    // Купить Pro — отправляем инвойс ЮKassa прямо в чат бота.
    if (dataKey === 'buy_pro') { await sendProInvoice(chatId, userId); return; }

    // Раздел «Напоминания»: статус / выбор режима / включение / выключение.
    if (dataKey === 'reminders' || dataKey === 'reminders_pick' || dataKey === 'rem_off' || dataKey.startsWith('rem_set_')) {
      let screen;
      if (dataKey === 'rem_off') { unsubscribeReminders(userId); screen = remindersOff; }
      else if (!isPro(userId)) { screen = remindersUpsell; } // напоминания — часть Pro
      else if (dataKey === 'reminders_pick') { screen = remindersPicker(); }
      else if (dataKey.startsWith('rem_set_')) {
        const regime = REM_FAMILY[dataKey.slice('rem_set_'.length)];
        if (regime) { subscribeReminders(userId, chatId, regime); screen = remindersConfirm(userId); }
        else screen = remindersPicker();
      } else { screen = remindersStatus(userId); }
      await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: screen.text, parse_mode: 'HTML', reply_markup: screen.keyboard, disable_web_page_preview: true });
      return;
    }

    if (dataKey === 'menu') {
      await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: MENU_TEXT, reply_markup: MENU_KEYBOARD });
    } else if (SECTIONS[dataKey]) {
      // У раздела «Сроки 2026» добавляем кнопку включения напоминаний.
      const kb = dataKey === 'dates'
        ? { inline_keyboard: [[{ text: '🔔 Включить напоминания', callback_data: 'reminders' }], [{ text: '← Назад в меню', callback_data: 'menu' }]] }
        : dataKey === 'pro'
        ? { inline_keyboard: [[{ text: `💳 Купить Pro — ${PRO_PRICE_RUB} ₽`, callback_data: 'buy_pro' }], [{ text: '← Назад в меню', callback_data: 'menu' }]] }
        : BACK_KEYBOARD;
      await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: SECTIONS[dataKey], parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
    }
    return;
  }

  // /start и /menu — показываем главное меню (или сразу раздел по deep-link параметру)
  if (update.message?.text?.startsWith('/start') || update.message?.text?.startsWith('/menu')) {
    const chatId = update.message.chat.id;
    const fromId = update.message.from?.id;
    // Часть после «/start » — deep-link параметр из приложения (t.me/бот?start=...).
    const payload = (update.message.text.split(/\s+/)[1] || '').trim();

    // Учёт источника перехода — только для /start (не /menu) и при известном userId.
    if (update.message.text.startsWith('/start') && fromId) {
      sourceStats = recordStart(sourceStats, payload, fromId, isoToday());
      saveSources();
    }

    // Deep-link «reminders» — выбор режима (или апселл, если нет Pro).
    if (payload === 'reminders') {
      const s = isPro(fromId) ? remindersPicker() : remindersUpsell;
      await tg('sendMessage', { chat_id: chatId, text: s.text, parse_mode: 'HTML', reply_markup: s.keyboard, disable_web_page_preview: true });
      return;
    }
    // Deep-link «rem_<семья>» — сразу подписать (один тап из калькулятора), если есть Pro.
    if (payload.startsWith('rem_')) {
      const regime = REM_FAMILY[payload.slice('rem_'.length)];
      if (regime) {
        let s;
        if (isPro(fromId)) { subscribeReminders(fromId, chatId, regime); s = remindersConfirm(fromId); }
        else s = remindersUpsell;
        await tg('sendMessage', { chat_id: chatId, text: s.text, parse_mode: 'HTML', reply_markup: s.keyboard, disable_web_page_preview: true });
        return;
      }
    }

    // Deep-link «claim_<token>» — перенос веб-оплаты в Telegram: проверяем оплату на сервере → выдаём Pro.
    if (payload.startsWith('claim_')) {
      const token = payload.slice('claim_'.length);
      const rec = webPro[token];
      // claim-ссылка действительна ограниченное время после оплаты (ограничивает срок жизни утёкшего токена).
      const claimCutoff = new Date(Date.now() - CLAIM_TTL_DAYS * 864e5).toISOString().slice(0, 10);
      const claimFresh = !!rec && (rec.paidAt || rec.createdAt || '0000-00-00') >= claimCutoff;
      let text;
      if (isPro(fromId)) {
        text = '✅ У вас уже есть Pro в Telegram — доступ навсегда. Откройте калькулятор, все функции активны.';
      } else if (isPaid(webPro, token) && !isClaimed(webPro, token) && claimFresh) {
        grantPro(fromId);
        webPro = markClaimed(webPro, token, fromId); saveWebPro();
        // Привязываем платёж ЮKassa к пользователю — чтобы возврат по веб-оплате снял Pro.
        rememberPayment(rec?.paymentId, fromId);
        text = '🎉 Pro активирован в Telegram! Спасибо за покупку. Все Pro-функции открыты — нажмите «Открыть калькулятор».';
      } else if (isPaid(webPro, token) && isClaimed(webPro, token)) {
        text = 'Эта покупка уже привязана к аккаунту Telegram. Если это ошибка — напишите нам.';
      } else if (isPaid(webPro, token) && !claimFresh) {
        text = 'Ссылка активации устарела. Напишите нам (filimonov.filimonov05@mail.ru) — поможем перенести Pro в Telegram.';
      } else {
        text = 'Не удалось подтвердить покупку по ссылке (возможно, оплата ещё обрабатывается — попробуйте через минуту). Если вы оплатили на сайте — напишите нам, поможем.';
      }
      await tg('sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: [
        [{ text: '🧮 Открыть калькулятор', web_app: { url: WEBAPP_URL } }],
        [{ text: '← В меню', callback_data: 'menu' }],
      ] } });
      return;
    }

    console.log('[/start] получен от', fromId, '— отправляю меню');
    const r = await tg('sendMessage', { chat_id: chatId, text: MENU_TEXT, reply_markup: MENU_KEYBOARD });
    console.log('[/start] ответ Telegram:', JSON.stringify(r).slice(0, 300));
    return;
  }

  // --- Админ-команды (только для ADMIN_IDS) ---
  const msgText = update.message?.text || '';
  const fromId = update.message?.from?.id;
  if (msgText.startsWith('/') && isAdmin(fromId)) {
    const chatId = update.message.chat.id;
    const [cmd, arg] = msgText.trim().split(/\s+/);

    if (cmd === '/admin' || cmd === '/help') {
      await tg('sendMessage', { chat_id: chatId, text:
        'Команды администратора:\n' +
        '/grant ID — выдать Pro пользователю\n' +
        '/revoke ID — снять Pro\n' +
        '/check ID — проверить статус\n' +
        '/list — сколько всего с Pro\n' +
        '/remstats — сколько подписок на напоминания\n' +
        '/srcstats — откуда приходят в бота (метки start)\n' +
        '/testreminder — прислать пример напоминания\n\n' +
        'ID пользователя можно узнать: попросите его написать боту @userinfobot.' });
      return;
    }
    if (cmd === '/grant' && arg) {
      grantPro(arg);
      await tg('sendMessage', { chat_id: chatId, text: `✅ Pro выдан пользователю ${arg}.` });
      return;
    }
    if (cmd === '/revoke' && arg) {
      revokePro(arg);
      await tg('sendMessage', { chat_id: chatId, text: `🚫 Pro снят у пользователя ${arg}.` });
      return;
    }
    if (cmd === '/check' && arg) {
      await tg('sendMessage', { chat_id: chatId, text: `Пользователь ${arg}: ${isPro(arg) ? 'Pro активен ✅' : 'без Pro'}` });
      return;
    }
    if (cmd === '/list') {
      await tg('sendMessage', { chat_id: chatId, text: `Всего пользователей с Pro: ${proUsers.size}` });
      return;
    }
    if (cmd === '/remstats') {
      const subs = Object.values(reminders).filter((s) => s?.regime);
      const byRegime = subs.reduce((m, s) => ((m[REGIME_LABELS[s.regime] || s.regime] = (m[REGIME_LABELS[s.regime] || s.regime] || 0) + 1), m), {});
      const lines = Object.entries(byRegime).map(([k, v]) => `  ${k}: ${v}`).join('\n');
      await tg('sendMessage', { chat_id: chatId, text: `Подписок на напоминания: ${subs.length}` + (lines ? `\n${lines}` : '') });
      return;
    }
    if (cmd === '/srcstats') {
      await tg('sendMessage', { chat_id: chatId, text: formatSourceStats(sourceStats) });
      return;
    }
    if (cmd === '/testreminder') {
      // Шлём пример напоминания себе — проверить вид и доставку (в базу не пишется).
      await sendReminder(chatId, 'usn6', { title: 'Аванс по УСН за полугодие', date: '2026-07-28', kind: 'Аванс', daysLeft: 3 });
      await tg('sendMessage', { chat_id: chatId, text: '↑ так выглядит напоминание подписчикам (тестовое сообщение).' });
      return;
    }
  }

  // pre_checkout — обязательно ответить в течение 10 секунд, иначе оплата отменится
  if (update.pre_checkout_query) {
    await tg('answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
    return;
  }

  // successful_payment — оплата прошла, выдаём Pro навсегда
  if (update.message?.successful_payment) {
    const userId = update.message.from.id;
    const sp = update.message.successful_payment;
    // Валидация платежа — Pro выдаём ТОЛЬКО за реальную оплату нужной суммы (защита от подделки апдейта).
    const payloadOk = typeof sp.invoice_payload === 'string' && sp.invoice_payload.startsWith(`pro_${userId}_`);
    const amountOk = sp.currency === 'RUB' && Number(sp.total_amount) === PRO_PRICE_RUB * 100;
    if (!payloadOk || !amountOk) {
      console.log('[payment] ОТКЛОНЁН подозрительный платёж userId', userId, '| payloadOk', payloadOk, '| currency', sp.currency, '| amount', sp.total_amount);
      return;
    }
    grantPro(userId);
    // Запоминаем id платежа ЮKassa, чтобы при возврате найти этого пользователя.
    rememberPayment(sp.provider_payment_charge_id, userId);
    console.log('[payment] Pro выдан userId', userId, 'payment', sp.provider_payment_charge_id);
    await tg('sendMessage', {
      chat_id: update.message.chat.id,
      text: '🎉 Pro активирован навсегда! Открыты детальная разбивка, сценарии роста, точки перелома, черновик декларации УСН, налоговый календарь, PDF-отчёт и напоминания о сроках.',
      reply_markup: { inline_keyboard: [
        [{ text: '🚀 Открыть Pro', web_app: { url: WEBAPP_URL } }],
        [{ text: '🔔 Включить напоминания о сроках', callback_data: 'reminders' }],
      ] },
    });
    return;
  }
}

// --- Планировщик напоминаний о налоговых сроках ---
// Бот работает постоянно, поэтому раз в несколько часов проверяем, кому пора напомнить.
// Стадии/дедупликация — в shared/reminders.js (dueReminders), чтобы логику можно было тестировать.
const REMINDER_TICK_MS = 3 * 60 * 60 * 1000; // каждые 3 часа
const mskHour = (now) => (now.getUTCHours() + 3) % 24; // МСК = UTC+3 (без перехода на лето)

async function sendReminder(chatId, regime, item) {
  const text =
    '🔔 <b>Скоро налоговый срок</b>\n\n' +
    `<b>${item.title}</b>\n` +
    `📅 ${formatDateRu(item.date)} — ${daysLeftPhrase(item.daysLeft)}\n` +
    `Режим: ${REGIME_LABELS[regime] || regime}\n\n` +
    'Не забудьте оплатить или подать вовремя, чтобы избежать пеней.';
  const r = await tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: '🧮 Открыть калькулятор', url: MINIAPP_LINK }],
      [{ text: '🔕 Отключить напоминания', callback_data: 'rem_off' }],
    ] },
  });
  if (!r.ok) console.log('[reminders] не отправлено', chatId, JSON.stringify(r).slice(0, 200));
  return r.ok;
}

// Убираем из sent старые ключи (>14 дней назад), чтобы файл не разрастался.
function pruneSent(now) {
  const cutoff = new Date(now.getTime() - 14 * 864e5).toISOString().slice(0, 10);
  for (const sub of Object.values(reminders)) {
    if (!sub?.sent) continue;
    for (const key of Object.keys(sub.sent)) {
      if (key.split(':')[0] < cutoff) delete sub.sent[key];
    }
  }
}

async function runReminderCheck() {
  try {
    const now = new Date();
    const h = mskHour(now);
    if (h < 9 || h >= 21) return; // не беспокоим ночью по МСК
    let sentCount = 0;
    for (const [userId, sub] of Object.entries(reminders)) {
      if (!sub?.regime) continue;
      if (!isPro(userId)) continue; // напоминания только для Pro (учитывает возврат/отзыв Pro)
      const chatId = sub.chatId || userId;
      for (const item of dueReminders(sub.regime, now, sub.sent || {})) {
        const ok = await sendReminder(chatId, sub.regime, item);
        if (ok) { sub.sent = sub.sent || {}; sub.sent[item.key] = true; sentCount++; }
      }
    }
    pruneSent(now);
    saveReminders();
    if (sentCount) console.log(`[reminders] отправлено напоминаний: ${sentCount}`);
  } catch (e) {
    console.log('[reminders] ошибка тика:', e?.message);
  }
}

// --- утилиты ---
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      data += c;
      if (data.length > MAX_BODY) { aborted = true; try { req.destroy(); } catch (_) {} resolve({}); }
    });
    req.on('end', () => { if (!aborted) { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } } });
    req.on('error', () => { if (!aborted) resolve({}); });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, () => {
  console.log(`✅ Бот-бэкенд слушает порт ${PORT}`);
  console.log(`   Версия кода: МЕНЮ-2 + напоминания о сроках`);
  console.log(`   Mini App: ${WEBAPP_URL}`);
  console.log(`   Подписок на напоминания: ${Object.keys(reminders).length}`);
  console.log(`   Источников переходов: ${Object.keys(sourceStats.sources).length}`);
  console.log(`   Цена Pro: ${PRO_PRICE_RUB} ₽ через ЮKassa (разовая покупка, навсегда)`);
  console.log(`   Платёжный токен ЮKassa: ${PROVIDER_TOKEN ? 'задан ✓' : 'НЕ задан ✗'}`);
  // Применяем secret_token к УЖЕ установленному вебхуку (URL узнаём через getWebhookInfo;
  // токен в логи не печатаем). Если вебхук ещё не установлен — пропускаем, бот продолжит работать.
  (async () => {
    try {
      const info = await tg('getWebhookInfo');
      const url = info?.result?.url;
      if (url) {
        const r = await tg('setWebhook', {
          url,
          secret_token: WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
          drop_pending_updates: false,
        });
        if (r.ok) webhookSecretApplied = true;
        console.log('[webhook] secret_token применён:', r.ok ? 'ок ✓' : (r.description || 'ошибка'));
      } else {
        console.log('[webhook] вебхук в Telegram не установлен — установите вручную (secret применится при следующем старте).');
      }
    } catch (e) {
      console.log('[webhook] не удалось применить secret_token:', e?.message || e);
    }
  })();

  // Планировщик напоминаний: первый прогон через 20 с после старта, далее раз в 3 часа.
  setTimeout(runReminderCheck, 20000);
  setInterval(runReminderCheck, REMINDER_TICK_MS);
});
