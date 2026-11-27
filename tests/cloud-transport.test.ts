import assert from 'node:assert/strict';
import test from 'node:test';
import { canFallbackToLocalSaleBeforeRpc, isTransientCloudTransportError, resolveLocalSaleFallbackId } from '../src/lib/cloudTransport.ts';

test('classifies browser and Electron network transport failures as retryable', () => {
  for (const message of [
    'TypeError: Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_CONNECTION_RESET',
    'getaddrinfo ENOTFOUND api.example.test',
    'The request timed out',
    'offline',
    'HTTP 503 Service Unavailable',
    '502 Bad Gateway',
    '504 Gateway Timeout',
    'HTTP 429 Too Many Requests',
  ]) assert.equal(isTransientCloudTransportError(message), true, message);
});

test('does not classify authorization, branch binding or business validation as transport loss', () => {
  for (const message of [
    'Cloud sign-in required once in Settings.',
    'User is not authorized to receive GRNs',
    'This POS is not assigned to an active branch.',
    'Insufficient stock for product',
    'duplicate key value violates unique constraint',
    'HTTP 403 Forbidden',
  ]) assert.equal(isTransientCloudTransportError(message), false, message);
});

test('allows local fallback only for transient failures before the atomic RPC', () => {
  assert.equal(canFallbackToLocalSaleBeforeRpc(false, 'TypeError: Failed to fetch'), true);
  assert.equal(canFallbackToLocalSaleBeforeRpc(false, 'HTTP 503 Service Unavailable'), true);
  assert.equal(canFallbackToLocalSaleBeforeRpc(true, 'TypeError: Failed to fetch'), false);
  assert.equal(canFallbackToLocalSaleBeforeRpc(true, 'HTTP 503 Service Unavailable'), false);
  assert.equal(canFallbackToLocalSaleBeforeRpc(undefined, 'offline'), false);
  assert.equal(canFallbackToLocalSaleBeforeRpc(false, 'HTTP 403 Forbidden'), false);
});


test('allows a fresh local fallback when there is no unresolved cloud sale marker', () => {
  assert.deepEqual(resolveLocalSaleFallbackId({
    cloudConfigured: true,
    pendingMarkerRaw: null,
    cloudShopId: 'shop-a',
  }), { ok: true });
});

test('reuses the exact pending Sale ID only when the pre-RPC attempt matches its shop', () => {
  assert.deepEqual(resolveLocalSaleFallbackId({
    cloudConfigured: true,
    requestedSaleId: 'sale-stable-1',
    pendingMarkerRaw: JSON.stringify({ saleId: 'sale-stable-1', shopId: 'shop-a' }),
    cloudShopId: 'shop-a',
    allowMatchingPendingId: true,
  }), { ok: true, saleId: 'sale-stable-1' });
});

test('blocks local fallback when an ambiguous previous cloud sale has a different or unknown ID', () => {
  const raw = JSON.stringify({ saleId: 'sale-previous', shopId: 'shop-a' });
  const differentId = resolveLocalSaleFallbackId({
    cloudConfigured: true,
    requestedSaleId: 'sale-new',
    pendingMarkerRaw: raw,
    cloudShopId: 'shop-a',
  });
  const unknownId = resolveLocalSaleFallbackId({
    cloudConfigured: true,
    pendingMarkerRaw: raw,
    cloudShopId: 'shop-a',
  });
  assert.equal(differentId.ok, false);
  assert.equal(unknownId.ok, false);
});

test('blocks pending cloud sale markers that belong to another or unresolved shop', () => {
  const result = resolveLocalSaleFallbackId({
    cloudConfigured: true,
    requestedSaleId: 'sale-stable-1',
    pendingMarkerRaw: JSON.stringify({ saleId: 'sale-stable-1', shopId: 'shop-original' }),
    cloudShopId: 'shop-current',
  });
  assert.equal(result.ok, false);
});

test('fails closed when the cloud retry marker cannot be read or parsed', () => {
  const unreadable = resolveLocalSaleFallbackId({
    cloudConfigured: true,
    requestedSaleId: 'sale-1',
    pendingMarkerRaw: null,
    markerReadable: false,
    cloudShopId: 'shop-a',
  });
  const malformed = resolveLocalSaleFallbackId({
    cloudConfigured: true,
    requestedSaleId: 'sale-1',
    pendingMarkerRaw: '{not-json',
    cloudShopId: 'shop-a',
  });
  assert.equal(unreadable.ok, false);
  assert.equal(malformed.ok, false);
});

test('local-only POS is not blocked by an unrelated legacy cloud retry marker', () => {
  assert.deepEqual(resolveLocalSaleFallbackId({
    cloudConfigured: false,
    pendingMarkerRaw: '{not-json',
    markerReadable: false,
  }), { ok: true });
});


test('does not reuse a matching cloud marker without proof that the current RPC was not sent', () => {
  const result = resolveLocalSaleFallbackId({
    cloudConfigured: true,
    requestedSaleId: 'sale-stable-1',
    pendingMarkerRaw: JSON.stringify({ saleId: 'sale-stable-1', shopId: 'shop-a' }),
    cloudShopId: 'shop-a',
    allowMatchingPendingId: false,
  });
  assert.equal(result.ok, false);
});
