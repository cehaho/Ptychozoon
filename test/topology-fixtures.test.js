'use strict';

// Cases shared with src-tauri/src/topology.rs (see `shared_fixtures` there):
// Topology.read and read_document must give the same document, or the same
// error, for each input in test/fixtures/topology.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Topology = require('../renderer/js/topology.js');

const cases = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'topology.json'), 'utf8')
);

for (const item of cases) {
  test(`shared topology case: ${item.name}`, () => {
    const result = Topology.read(structuredClone(item.input));
    if (item.error) {
      assert.deepEqual({ ok: result.ok, error: result.error }, { ok: false, error: item.error });
    } else {
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.document, item.document);
    }
  });
}
