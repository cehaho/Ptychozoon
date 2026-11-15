'use strict';

// Cases shared with src-tauri/src/hosts.rs (see `shared_fixtures` there):
// both implementations must give the answers in test/fixtures/hosts.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Hosts = require('../lib/hosts');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hosts.json'), 'utf8'));

test('isSafeHost matches the shared fixture', () => {
  for (const [host, expected] of cases.isSafeHost) {
    assert.equal(Hosts.isSafeHost(host), expected, JSON.stringify(host));
  }
});

test('isIpv6 matches the shared fixture', () => {
  for (const [host, expected] of cases.isIpv6) {
    assert.equal(Hosts.isIpv6(host), expected, JSON.stringify(host));
  }
});

test('normalizeHost matches the shared fixture', () => {
  for (const [host, expected] of cases.normalizeHost) {
    assert.equal(Hosts.normalizeHost(host), expected, JSON.stringify(host));
  }
});

test('formatHostPort matches the shared fixture', () => {
  for (const [host, port, expected] of cases.formatHostPort) {
    assert.equal(Hosts.formatHostPort(host, port), expected);
  }
});

test('isSafeBaseIp matches the shared fixture', () => {
  for (const [base, expected] of cases.isSafeBaseIp) {
    assert.equal(Hosts.isSafeBaseIp(base), expected, JSON.stringify(base));
  }
});

test('isSafePort matches the shared fixture', () => {
  for (const [port, expected] of cases.isSafePort) {
    assert.equal(Hosts.isSafePort(port), expected, String(port));
  }
});

test('clampScanRange matches the shared fixture', () => {
  for (const [start, end, expected] of cases.clampScanRange) {
    const range = Hosts.clampScanRange(start, end);
    assert.deepEqual(range && [range.start, range.end], expected, `${start}-${end}`);
  }
});

test('pingCommand matches the shared fixture', () => {
  for (const item of cases.pingCommand) {
    assert.deepEqual(
      Hosts.pingCommand(item.host, item.platform.node),
      { command: item.command, args: item.args },
      `${item.host} on ${item.platform.node}`
    );
  }
});

test('monitoringInterval and confirmationCount match the shared fixture', () => {
  for (const [requested, expected] of cases.monitoringInterval) {
    assert.equal(Hosts.monitoringInterval(requested), expected, String(requested));
  }
  for (const [requested, expected] of cases.confirmationCount) {
    assert.equal(Hosts.confirmationCount(requested), expected, String(requested));
  }
});
