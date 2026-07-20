#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyLiveTestReport(report) {
  if (report?.success !== true || report?.numFailedTests !== 0) {
    throw new Error('Production smoke suite did not complete successfully');
  }
  if (!Number.isInteger(report.numPassedTests) || report.numPassedTests === 0) {
    throw new Error('Production smoke suite executed zero passing tests');
  }
  if (report.numPendingTests !== 0) {
    throw new Error(`Production smoke suite skipped ${report.numPendingTests} test(s)`);
  }
  if (report.numTotalTests !== report.numPassedTests) {
    throw new Error('Production smoke suite report totals are inconsistent');
  }
  return report.numPassedTests;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('Usage: node scripts/verify-live-test-report.mjs <vitest-json-report>');
    process.exitCode = 2;
  } else {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const passed = verifyLiveTestReport(report);
      console.log(`Production smoke suite proved ${passed} live tests ran`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Production smoke report verification failed');
      process.exitCode = 1;
    }
  }
}
