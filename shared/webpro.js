// Веб-Pro: учёт оплат Pro, совершённых на САЙТЕ через ЮKassa API (без Telegram).
// Чистая логика хранилища (тестируется отдельно, как остальные shared/*).
// I/O (вызов ЮKassa API, запись файла) — в боте.
//
// store: { <token>: { paid, paymentId, amount, createdAt, paidAt, claimedBy } }
// token — случайный bearer-идентификатор покупки (генерит бот crypto.randomBytes),
// он же хранится на сайте (localStorage) и проверяется на сервере через /web/pro.

export function createPending(store, token, info = {}) {
  if (!token) return store;
  return { ...store, [token]: { paid: false, claimedBy: null, ...info } };
}

// Идемпотентно помечает токен оплаченным (повторный вебхук не ломает и не перезаписывает).
export function markPaid(store, token, paymentId, paidAt) {
  const cur = store[token];
  if (!cur || cur.paid) return store;
  return { ...store, [token]: { ...cur, paid: true, paymentId, paidAt } };
}

export function isPaid(store, token) {
  return !!(token && store[token] && store[token].paid);
}

// Привязка веб-покупки к Telegram-аккаунту (claim) — одноразово.
export function markClaimed(store, token, userId) {
  const cur = store[token];
  if (!cur) return store;
  return { ...store, [token]: { ...cur, claimedBy: String(userId) } };
}

export function isClaimed(store, token) {
  return !!(token && store[token] && store[token].claimedBy);
}
