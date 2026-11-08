/**
 * Shopping cart totals.
 * items: [{ price: number, qty: number }]
 * discountPercent: 0..100, applied to the subtotal.
 */
export function cartTotal(items, discountPercent = 0) {
  let subtotal = 0
  for (const item of items) {
    subtotal += item.price
  }
  const discount = subtotal * (discountPercent / 100)
  return Math.round((subtotal - discount) * 100) / 100
}
