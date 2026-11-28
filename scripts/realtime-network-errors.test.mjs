import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unexpectedNetworkErrors } from './realtime-network-errors.mjs';
test('never accepts rate, internal, schema, projection or unexpected epoch errors', () => {
  const errors = ['RATE_LIMIT','INTERNAL_ERROR','SERVER_ERROR','INVALID_INPUT','PROJECTION_FAILED','STALE_EPOCH'].map(code => ({code,silenceMs:15000}));
  assert.deepEqual(unexpectedNetworkErrors(errors,100),errors);
});
test('permits only liveness authority errors after an observed five-second loss stall', () => {
  for(const code of ['AUTH_EXPIRED','STALE_CONTROLLER','CONTROL_REQUIRED']) {
    const late={code,silenceMs:5000}; assert.deepEqual(unexpectedNetworkErrors([late],5),[]);
    assert.deepEqual(unexpectedNetworkErrors([late],0),[late]);
    const early={code,silenceMs:4999};assert.deepEqual(unexpectedNetworkErrors([early],5),[early]);
  }
});
