'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Flows = require('../renderer/js/flows.js');

test('isSafeFolder accepts absolute paths without quotes or control characters', () => {
  assert.equal(Flows.isSafeFolder('/mnt/datastore/vm'), true);
  assert.equal(Flows.isSafeFolder('/srv/backup dir'), true);
  assert.equal(Flows.isSafeFolder('relative/path'), false);
  assert.equal(Flows.isSafeFolder("/x'; rm -rf /; '"), false);
  assert.equal(Flows.isSafeFolder('/x\n/y'), false);
  assert.equal(Flows.isSafeFolder(null), false);
});

test('editError explains what blocks a save', () => {
  const flow = Flows.createFlow('a', 'b');
  assert.equal(Flows.editError(flow), '');
  assert.match(Flows.editError({ ...flow, targetNodeId: 'a' }), /different/);
  assert.match(
    Flows.editError({ ...flow, check: { type: 'folder', path: 'backup' } }),
    /absolute path/
  );
  assert.match(Flows.editError({ ...flow, check: { type: 'command', command: '  ' } }), /command/);
  assert.match(Flows.editError({ ...flow, check: { type: 'http', url: 'ftp://x' } }), /http/);
  assert.equal(
    Flows.editError({ ...flow, check: { type: 'http', url: 'https://nas/s.json' } }),
    ''
  );
});

test('ageText rounds to minutes, hours, then days', () => {
  assert.equal(Flows.ageText(20 * 1000), 'just now');
  assert.equal(Flows.ageText(12 * 60000), '12 min');
  assert.equal(Flows.ageText(5 * 3600000), '5 h');
  assert.equal(Flows.ageText(47 * 3600000), '47 h');
  assert.equal(Flows.ageText(72 * 3600000), '3 d');
  assert.equal(Flows.ageText(NaN), '');
});

test('caption shows the name and the age of the last backup', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const flow = { name: 'VMs', tool: 'PBS' };
  assert.equal(
    Flows.caption(flow, { state: 'ok', last: '2026-11-15T09:00:00Z' }, now),
    'VMs · 3 h ago'
  );
  assert.equal(Flows.caption({ tool: 'PBS' }, { state: 'failed' }, now), 'PBS · failed');
  assert.equal(Flows.caption({}, null, now), 'Backup');
});

test('transitions notify once when a flow becomes late or failed', () => {
  const flows = [{ id: 'f', name: 'VMs', maxAgeHours: 26 }];
  const previous = new Map();
  assert.deepEqual(Flows.transitions(previous, [{ id: 'f', state: 'ok' }], flows), []);
  const late = Flows.transitions(previous, [{ id: 'f', state: 'late' }], flows);
  assert.equal(late.length, 1);
  assert.equal(late[0].title, 'Backup late');
  assert.match(late[0].body, /26 h/);
  assert.deepEqual(Flows.transitions(previous, [{ id: 'f', state: 'late' }], flows), []);
  const failed = Flows.transitions(
    previous,
    [{ id: 'f', state: 'failed', detail: 'disk full' }],
    flows
  );
  assert.equal(failed[0].title, 'Backup failed');
  assert.match(failed[0].body, /disk full/);
  assert.deepEqual(Flows.transitions(previous, [{ id: 'gone', state: 'late' }], flows), []);
});

test('boxExit leaves the box on the side facing the other point', () => {
  const box = { x: 100, y: 100, width: 140, height: 140 };
  assert.deepEqual(Flows.boxExit(box, 400, 100), { x: 170, y: 100 });
  assert.deepEqual(Flows.boxExit(box, 100, -200), { x: 100, y: 30 });
  assert.deepEqual(Flows.boxExit(box, 100, 100), { x: 100, y: 100 });
});

test('arrowPath bends to one side, and further for the next lane', () => {
  const a = { x: 0, y: 0, width: 100, height: 100 };
  const b = { x: 400, y: 0, width: 100, height: 100 };
  const first = Flows.arrowPath(a, b, 0);
  assert.match(first.d, /^M 50 0 Q 200 \S+ 350 0$/);
  assert.equal(first.labelX, 200);
  assert.ok(first.labelY > 0);
  const second = Flows.arrowPath(a, b, 1);
  assert.ok(second.labelY > first.labelY);
  // The reverse flow bends the other way.
  assert.ok(Flows.arrowPath(b, a, 0).labelY < 0);
});

test('importMessage warns about commands that need approval', () => {
  const Topology = require('../renderer/js/topology.js');
  const doc = Topology.emptyDocument();
  doc.flows = [{ check: { type: 'command' } }, { check: { type: 'none' } }];
  const message = Topology.importMessage(doc);
  assert.match(message, /Backup flows: 2/);
  assert.match(message, /1 backup check\(s\) run a command/);
  assert.doesNotMatch(Topology.importMessage(Topology.emptyDocument()), /Backup flows/);
});
