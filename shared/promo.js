// Промо «первым N покупателям дешевле»: пока число оплативших меньше лимита — цена promo,
// затем — full. Чистая логика (тестируется отдельно, как остальные shared/*).
// Источник правды о числе оплативших — бот (proUsers.size); фронт получает результат через /me.
export function promoState({ paidCount = 0, limit = 0, promo, full }) {
  const lim = Math.max(0, Number(limit) || 0);
  const paid = Math.max(0, Number(paidCount) || 0);
  const pPromo = Number(promo);
  const pFull = Number(full);
  // Промо активно, только если задан лимит, мест ещё хватает и promo реально дешевле full.
  const active = lim > 0 && paid < lim && pPromo < pFull;
  return {
    price: active ? pPromo : pFull,
    promo: pPromo,
    full: pFull,
    spotsLeft: active ? lim - paid : 0,
    isPromo: active,
  };
}
