import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyLiveTestReport } from './verify-live-test-report.mjs';

test('accepts a successful live suite with executed tests and no skips', () => {
  assert.equal(verifyLiveTestReport({
    success: true,
    numTotalTests: 9,
    numPassedTests: 9,
    numFailedTests: 0,
    numPendingTests: 0,
  }), 9);
});

test('rejects a green report where every live test skipped', () => {
  assert.throws(() => verifyLiveTestReport({
    success: true,
    numTotalTests: 9,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 9,
  }), /zero passing tests/);
});

test('rejects partial skips and failed reports', () => {
  assert.throws(() => verifyLiveTestReport({
    success: true,
    numTotalTests: 9,
    numPassedTests: 8,
    numFailedTests: 0,
    numPendingTests: 1,
  }), /skipped 1 test/);
  assert.throws(() => verifyLiveTestReport({
    success: false,
    numTotalTests: 9,
    numPassedTests: 8,
    numFailedTests: 1,
    numPendingTests: 0,
  }), /did not complete successfully/);
});
