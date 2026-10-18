import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesCreditPhoneDigits,
  normalizeCreditPhoneSearch,
  normalizeCreditSearchDigits,
} from '../src/lib/creditSearch.ts';

test('phone search removes whitespace without changing other characters', () => {
  assert.equal(normalizeCreditPhoneSearch(' +94 77\t123 4567 '), '+94771234567');
});

test('digit normalization removes punctuation and non-digits', () => {
  assert.equal(normalizeCreditSearchDigits('+94 (77) 123-4567'), '94771234567');
  assert.equal(normalizeCreditSearchDigits('abc'), '');
});

test('recent credit collection search matches formatted phone numbers', () => {
  assert.equal(matchesCreditPhoneDigits('+94 77 123-4567', '077 123'), true);
  assert.equal(matchesCreditPhoneDigits('0771234567', '+94 77'), true);
  assert.equal(matchesCreditPhoneDigits('0771234567', 'no phone digits'), false);
  assert.equal(matchesCreditPhoneDigits('0771234567', ''), false);
});
