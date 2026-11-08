import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cartTotal } from '../src/cart.js'

test('sums price times quantity', () => {
  assert.equal(cartTotal([{ price: 2.5, qty: 4 }, { price: 1, qty: 3 }]), 13)
})

test('applies a percentage discount', () => {
  assert.equal(cartTotal([{ price: 10, qty: 2 }], 25), 15)
})

test('empty cart is zero', () => {
  assert.equal(cartTotal([]), 0)
})
