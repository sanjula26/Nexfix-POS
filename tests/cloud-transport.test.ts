import assert from 'node:assert/strict';
import test from 'node:test';
import { isTransientCloudTransportError } from '../src/lib/cloudTransport.ts';

test('classifies browser and Electron network transport failures as retryable', () => {
  for (const message of [
    'TypeError: Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_CONNECTION_RESET',
    'getaddrinfo ENOTFOUND api.example.test',
    'The request timed out',
    'offline',
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
