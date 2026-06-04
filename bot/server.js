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
import { readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://example.com/webapp/index.html';
// Порт: Amvera ожидает 80 (см. amvera.yml containerPort). Локально можно задать PORT.
const PORT = process.env.PORT || 80;
// ID администратора (ваш Telegram ID) — кому доступны команды управления Pro.
// Через запятую можно указать несколько. Узнать свой ID: напишите боту @userinfobot.
const ADMIN_IDS = (process.env.ADMIN_IDS || '702308050').split(',').map((s) => s.trim()).filter(Boolean);
const isAdmin = (userId) => ADMIN_IDS.includes(String(userId));

// --- Оплата через ЮKassa (рубли картой прямо в Telegram) ---
// PROVIDER_TOKEN — «платёжный токен» из @BotFather (Bot Settings → Payments → ЮKassa).
// Это НЕ секретный ключ из ЛК ЮKassa — отдельный токен для бота, выдаётся при привязке магазина.
const PROVIDER_TOKEN = process.env.PROVIDER_TOKEN || '';
// Цена Pro в рублях. Pro — РАЗОВАЯ покупка, доступ навсегда (без подписки/продлений).
const PRO_PRICE_RUB = Number(process.env.PRO_PRICE_RUB || 1990);
// Ставка НДС для чека 54-ФЗ: 1 = без НДС (для ИП на УСН/НПД). См. ЛК ЮKassa.
const VAT_CODE = Number(process.env.VAT_CODE || 1);
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

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
} catch (_) {}
// Карта «платёж ЮKassa → userId» — чтобы при возврате знать, у кого забрать Pro.
// ЮKassa в уведомлении о возврате присылает id платежа, а не Telegram userId.
const PAY_MAP_PATH = process.env.DATA_DIR
  ? new URL('payments.json', `file://${process.env.DATA_DIR.replace(/\/?$/, '/')}`)
  : new URL('./payments.json', import.meta.url);
let payToUser = {};
try { payToUser = JSON.parse(readFileSync(PAY_MAP_PATH, 'utf8')); } catch (_) {}

function saveDb() {
  try { writeFileSync(DB_PATH, JSON.stringify([...proUsers])); } catch (_) {}
}
function savePayMap() {
  try { writeFileSync(PAY_MAP_PATH, JSON.stringify(payToUser)); } catch (_) {}
}
function grantPro(userId) { proUsers.add(String(userId)); saveDb(); }
function revokePro(userId) { proUsers.delete(String(userId)); saveDb(); }
function isPro(userId) { return proUsers.has(String(userId)); }
function rememberPayment(paymentId, userId) {
  if (paymentId) { payToUser[String(paymentId)] = String(userId); savePayMap(); }
}

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

  // 3) Вебхук Telegram (обновления бота)
  if (req.url === `/webhook/${BOT_TOKEN}` && req.method === 'POST') {
    await handleUpdate(body);
    return json(res, 200, { ok: true });
  }

  // 4) Вебхук ЮKassa: уведомление о ВОЗВРАТЕ → автоматически забираем Pro.
  // Настраивается в ЛК ЮKassa (HTTP-уведомления), событие refund.succeeded.
  if (req.url === '/yookassa-webhook' && req.method === 'POST') {
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
    } catch (e) {
      console.log('[yookassa-webhook] ошибка обработки:', e?.message);
    }
    // ЮKassa ждёт 200, иначе будет повторять уведомление.
    return json(res, 200, { ok: true });
  }

  json(res, 200, { service: 'tax-navigator-bot', ok: true });
});

// --- Главное меню бота ---
const MENU_TEXT =
  '👋 «Налоговый навигатор ИП 2026»\n\n' +
  'Сравните 6 налоговых режимов с учётом реформы НДС и узнайте, сколько можно сэкономить. Базовый расчёт — бесплатно.\n\n' +
  'Выберите раздел:';

const MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: '🧮 Открыть калькулятор', web_app: { url: WEBAPP_URL } }],
    [{ text: '❓ Как это работает', callback_data: 'how' }, { text: '💎 Что даёт Pro', callback_data: 'pro' }],
    [{ text: '📅 Налоговые сроки 2026', callback_data: 'dates' }],
    [{ text: '🛡️ О сервисе и контакты', callback_data: 'about' }],
  ],
};

// Кнопка «назад в меню» для экранов-разделов.
const BACK_KEYBOARD = { inline_keyboard: [[{ text: '← Назад в меню', callback_data: 'menu' }]] };

// Тексты разделов меню.
const SECTIONS = {
  how:
    '❓ <b>Как это работает</b>\n\n' +
    'Откройте калькулятор, введите выручку и расходы за год — сервис сравнит 6 режимов налогообложения (НПД, УСН 6%, УСН 15%, ПСН, АУСН) и покажет самый выгодный.\n\n' +
    'Возле каждого поля есть подсказка «?» — если что-то непонятно, нажмите её. Заполнять нужно всего 2 главных поля: выручку и расходы.\n\n' +
    'Расчёт идёт прямо на вашем устройстве — цифры никуда не передаются.',
  pro:
    '💎 <b>Что даёт Pro</b> — 1990 ₽, разово, навсегда\n\n' +
    '🧭 Личная рекомендация словами: что выбрать и почему\n' +
    '📊 Разбивка нагрузки с графиками (налог, взносы, НДС)\n' +
    '📈 Сценарии роста и график налоговой кривой\n' +
    '🎯 Точки перелома — когда менять режим\n' +
    '📄 PDF-отчёт с логотипом для бухгалтера\n' +
    '📑 Черновик декларации УСН (КНД 1152017)\n' +
    '📅 Налоговый календарь под ваш режим\n\n' +
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
    'Политика конфиденциальности: ' + WEBAPP_URL.replace('/webapp/index.html', '/landing/privacy.html'),
};

// --- Обработка апдейтов Telegram ---
async function handleUpdate(update) {
  // Нажатие inline-кнопки меню (callback_query)
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const msgId = cq.message?.message_id;
    const dataKey = cq.data;
    // Отвечаем Telegram, что нажатие принято (убирает «часики» на кнопке).
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    if (dataKey === 'menu') {
      await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: MENU_TEXT, reply_markup: MENU_KEYBOARD });
    } else if (SECTIONS[dataKey]) {
      await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: SECTIONS[dataKey], parse_mode: 'HTML', reply_markup: BACK_KEYBOARD, disable_web_page_preview: true });
    }
    return;
  }

  // /start и /menu — показываем главное меню
  if (update.message?.text?.startsWith('/start') || update.message?.text?.startsWith('/menu')) {
    await tg('sendMessage', { chat_id: update.message.chat.id, text: MENU_TEXT, reply_markup: MENU_KEYBOARD });
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
        '/list — сколько всего с Pro\n\n' +
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
    grantPro(userId);
    // Запоминаем id платежа ЮKassa, чтобы при возврате найти этого пользователя.
    rememberPayment(sp.provider_payment_charge_id, userId);
    console.log('[payment] Pro выдан userId', userId, 'payment', sp.provider_payment_charge_id);
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
  console.log(`   Цена Pro: ${PRO_PRICE_RUB} ₽ через ЮKassa (разовая покупка, навсегда)`);
  console.log(`   Платёжный токен ЮKassa: ${PROVIDER_TOKEN ? 'задан ✓' : 'НЕ задан ✗'}`);
  console.log(`\n   Не забудьте установить вебхук:`);
  console.log(`   curl "${API}/setWebhook?url=https://ВАШ_ДОМЕН/webhook/${BOT_TOKEN}"`);
});
