import assert from 'node:assert/strict';
import test from 'node:test';
import { canFallbackToLocalSaleBeforeRpc, isTransientCloudTransportError } from '../src/lib/cloudTransport.ts';

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
