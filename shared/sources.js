// Учёт источников переходов в бота (start-метки deep-link).
// Чистая логика — без I/O, чтобы покрыть тестами (как shared/reminders.js).
// Бот вызывает recordStart на каждый /start и хранит результат в sources.json.
//
// Метрика «откуда пришли»: для каждой start-метки считаем общее число /start
// и уникальных пользователей по ПЕРВОМУ касанию (first-touch attribution).

const MAX_LEN = 32;

// Привести произвольную (пользователь-контролируемую!) start-метку к безопасному ключу.
// Пусто → 'direct'; мусор (после очистки пусто) → 'other'.
export function normalizeSource(payload) {
  const raw = String(payload == null ? '' : payload).trim();
  if (!raw) return 'direct';
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, MAX_LEN);
  return cleaned || 'other';
}

export function emptyStore() {
  return { sources: {}, seen: {} };
}

// Записать один /start. Возвращает НОВЫЙ store (иммутабельно — вход не меняем).
// store: { sources: { <src>: { starts, users, first, last } }, seen: { <userId>: <первая метка> } }
export function recordStart(store, payload, userId, today) {
  const src = normalizeSource(payload);
  const safe = store && store.sources && store.seen ? store : emptyStore();
  const userKey = String(userId);
  const isNewUser = !(userKey in safe.seen);
  const prev = safe.sources[src] || { starts: 0, users: 0, first: today, last: today };
  const entry = {
    starts: prev.starts + 1,
    users: prev.users + (isNewUser ? 1 : 0),
    first: prev.first || today,
    last: today,
  };
  return {
    sources: { ...safe.sources, [src]: entry },
    seen: isNewUser ? { ...safe.seen, [userKey]: src } : safe.seen,
  };
}

// Человекочитаемая сводка для админ-команды /srcstats.
export function formatSourceStats(store) {
  const sources = (store && store.sources) || {};
  const entries = Object.entries(sources);
  if (!entries.length) return 'Переходов в бота пока нет (метки start не зафиксированы).';
  const totalStarts = entries.reduce((n, [, v]) => n + (v.starts || 0), 0);
  const totalUsers = entries.reduce((n, [, v]) => n + (v.users || 0), 0);
  const lines = entries
    .sort((a, b) => (b[1].users - a[1].users) || (b[1].starts - a[1].starts))
    .map(([k, v]) => `  ${k}: ${v.starts} start (${v.users} уник)`)
    .join('\n');
  return `Переходы в бота: ${totalStarts} start, ${totalUsers} уник.\n${lines}`;
}
