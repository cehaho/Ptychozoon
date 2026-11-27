'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Discovery = require('../renderer/js/discovery.js');
const { shortName, build } = require('../scripts/build-oui.js');

test('suggests a name from the PTR short name, then vendor and last octet', () => {
  assert.equal(
    Discovery.suggestName({ ip: '192.168.1.20', hostname: 'nas.home.lan', vendor: 'Synology' }),
    'nas'
  );
  assert.equal(
    Discovery.suggestName({ ip: '192.168.1.42', vendor: 'Raspberry Pi Trading' }),
    'Raspberry Pi Trading 42'
  );
  assert.equal(Discovery.suggestName({ ip: '2001:db8::1a', vendor: 'Apple' }), 'Apple 1a');
  assert.equal(Discovery.suggestName({ ip: 'fe80::5%eth0', vendor: 'Apple' }), 'Apple 5');
  // A randomised MAC says nothing about the device.
  assert.equal(
    Discovery.suggestName({ ip: '192.168.1.7', vendor: Discovery.PRIVATE_VENDOR }),
    'Device 192.168.1.7'
  );
  // A resolver that echoes the address is not a name.
  assert.equal(Discovery.suggestName({ ip: '10.0.0.1', hostname: '10.0.0.1' }), 'Device 10.0.0.1');
  assert.equal(Discovery.shortHostName('printer.lan.'), 'printer');
});

test('a fingerprinted device names and icons the host before its vendor', () => {
  assert.equal(
    Discovery.suggestName({ ip: '192.168.1.42', vendor: 'Ubiquiti', device: 'UniFi OS' }),
    'UniFi OS 42'
  );
  assert.equal(Discovery.suggestIcon({ vendor: 'Ubiquiti', deviceKind: 'unifi' }), 'router');
  assert.equal(Discovery.suggestIcon({ deviceKind: 'airmax' }), 'wifi');
  assert.equal(Discovery.suggestIcon({ deviceKind: 'proxmox' }), 'server');
});

test('only Ubiquiti and Proxmox hosts are fingerprinted', () => {
  assert.equal(Discovery.identifyCandidate({ ip: '10.0.0.2', vendor: 'Ubiquiti' }), true);
  assert.equal(
    Discovery.identifyCandidate({ ip: '10.0.0.3', vendor: 'Proxmox Server Solutions' }),
    true
  );
  // A Ubiquiti AP usually has no PTR name at all.
  assert.equal(Discovery.identifyCandidate({ ip: '10.0.0.4', hostname: 'uap-lobby.lan' }), true);
  assert.equal(Discovery.identifyCandidate({ ip: '10.0.0.5', vendor: 'Dell' }), false);
  assert.equal(Discovery.identifyCandidate({ ip: '10.0.0.6' }), false);
  // Already known: no second probe.
  assert.equal(
    Discovery.identifyCandidate({ ip: '10.0.0.7', vendor: 'Ubiquiti', deviceKind: 'unifi' }),
    false
  );
});

test('suggests an icon from hostname keywords, then vendor', () => {
  assert.equal(Discovery.suggestIcon({ hostname: 'printer01.lan' }), 'printer');
  assert.equal(Discovery.suggestIcon({ hostname: 'gw.lan', vendor: 'Apple' }), 'router');
  assert.equal(Discovery.suggestIcon({ vendor: 'Synology' }), 'hard-drive');
  assert.equal(Discovery.suggestIcon({ vendor: 'Raspberry Pi Foundation' }), 'cpu');
  assert.equal(Discovery.suggestIcon({ vendor: 'Cisco Systems' }), 'router');
  assert.equal(Discovery.suggestIcon({ vendor: 'VMware' }), 'server');
  assert.equal(
    Discovery.suggestIcon({ hostname: 'laptop-anna', vendor: 'Cisco Systems' }),
    'laptop'
  );
  assert.equal(Discovery.suggestIcon({ vendor: Discovery.PRIVATE_VENDOR }), 'circle');
  assert.equal(Discovery.suggestIcon({}), 'circle');
});

test('skips addresses already on the canvas, comparing canonical forms', () => {
  const nodes = [
    { address: '192.168.1.1' },
    { address: '2001:DB8:0::1' },
    { address: '[fe80::1%eth0]' },
    { address: '' }
  ];
  const hosts = [
    { ip: '192.168.1.1' },
    { ip: '192.168.1.2' },
    { ip: '2001:db8::1' },
    { ip: 'fe80::1%eth0' },
    { ip: '192.168.1.2' },
    { ip: '' },
    null
  ];
  assert.deepEqual(
    Discovery.newHosts(hosts, nodes).map((h) => h.ip),
    ['192.168.1.2']
  );
  assert.equal(Discovery.canonicalAddress('2001:0DB8:0000::0001%eth0'), '2001:db8::1%eth0');
});

test('places new nodes on a grid near the centre, clear of existing nodes', () => {
  const positions = Discovery.placeNear({ x: 50, y: 50 }, 5, [{ x: 50, y: 50 }]);
  assert.equal(positions.length, 5);
  positions.forEach((p) => {
    assert.ok(
      Math.abs(p.x - 50) >= 160 || Math.abs(p.y - 50) >= 160,
      'not on top of the existing node'
    );
    assert.ok(Math.abs(p.x - 50) <= 200 && Math.abs(p.y - 50) <= 200, 'in the first ring');
  });
  const keys = new Set(positions.map((p) => p.x + ',' + p.y));
  assert.equal(keys.size, 5, 'no two new nodes share a cell');

  const first = Discovery.placeNear({ x: 50, y: 50 }, 1, []);
  assert.deepEqual(first, [{ x: 50, y: 50 }]);

  // There is no edge to run into, even far from the origin.
  Discovery.placeNear({ x: 9900, y: 9900 }, 12, []).forEach((p) => {
    assert.ok(Math.abs(p.x - 9900) <= 400 && Math.abs(p.y - 9900) <= 400);
  });
});

test('builds node fields for selected hosts', () => {
  const nodes = [{ address: '192.168.1.1', x: 50, y: 50 }];
  const hosts = [
    { ip: '192.168.1.1', mac: 'aa:bb:cc:dd:ee:01' },
    { ip: '192.168.1.20', mac: 'AA:BB:CC:DD:EE:20', hostname: 'nas.lan', vendor: 'Synology' },
    { ip: '192.168.1.30', vendor: 'Brother', name: '  Office printer ' }
  ];
  const fields = Discovery.nodesForHosts(hosts, nodes, { x: 50, y: 50 });
  assert.equal(fields.length, 2);
  assert.equal(fields[0].name, 'nas');
  assert.equal(fields[0].address, '192.168.1.20');
  assert.equal(fields[0].mac, 'aa:bb:cc:dd:ee:20');
  assert.equal(fields[0].icon, 'hard-drive');
  assert.equal(fields[0].iconType, 'lucide');
  assert.equal(fields[1].name, 'Office printer');
  assert.equal(fields[1].icon, 'printer');
  assert.equal(Object.prototype.hasOwnProperty.call(fields[1], 'mac'), false);
  assert.notDeepEqual([fields[0].x, fields[0].y], [fields[1].x, fields[1].y]);
});

test('OUI builder shortens IEEE names and groups prefixes by vendor', () => {
  assert.equal(shortName('Cisco Systems, Inc'), 'Cisco Systems');
  assert.equal(shortName('HUAWEI TECHNOLOGIES CO.,LTD'), 'HUAWEI');
  assert.equal(shortName('Raspberry Pi Trading Ltd'), 'Raspberry Pi Trading');
  assert.equal(shortName('Hon Hai Precision Ind. Co.,Ltd.'), 'Hon Hai Precision');
  const csv = [
    'Registry,Assignment,Organization Name,Organization Address',
    'MA-L,00000C,"Cisco Systems, Inc",170 West Tasman Drive San Jose CA US 95134',
    'MA-L,00000E,Fujitsu Limited,Kawasaki JP',
    'MA-L,00001D,"Cisco Systems, Inc",San Jose US',
    'MA-L,0050C2,IEEE Registration Authority,Piscataway US'
  ].join('\n');
  assert.equal(build(csv), 'Cisco Systems\t00000C,00001D\nFujitsu\t00000E\n');
  const manuf =
    '# comment\n00:00:0C\tCisco\tCisco Systems, Inc\n00:1B:C5:00:00/36\tConverging\tConverging Systems Inc.\n';
  assert.equal(build(manuf), 'Cisco Systems\t00000C\n');
});

test('OUI builder keeps the first organization of a prefix listed twice', () => {
  const csv = [
    'Registry,Assignment,Organization Name,Organization Address',
    'MA-L,080030,NETWORK RESEARCH CORPORATION,US',
    'MA-L,080030,CERN,CH'
  ].join('\n');
  assert.equal(build(csv), 'NETWORK RESEARCH\t080030\n');
});

test('the shipped OUI table is well formed and reasonably small', () => {
  const file = path.join(__dirname, '..', 'src-tauri', 'data', 'oui.txt');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(text) < 600 * 1024);
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.length > 10000);
  const seen = new Set();
  lines.forEach((line) => {
    const [name, list, extra] = line.split('\t');
    assert.ok(name && list && extra === undefined, line);
    list.split(',').forEach((prefix) => {
      assert.match(prefix, /^[0-9A-F]{6}$/);
      assert.ok(!seen.has(prefix), 'duplicate prefix ' + prefix);
      seen.add(prefix);
    });
  });
});

test('scanPlan fills the form from the interface network', () => {
  const plan = (address, netmask) => Discovery.scanPlan(address, netmask);
  assert.deepEqual(plan('192.168.1.37', '255.255.255.0'), {
    base: '192.168.1',
    start: 1,
    end: 254
  });
  assert.deepEqual(plan('192.168.1.70', '255.255.255.192'), {
    base: '192.168.1',
    start: 65,
    end: 126
  });
  assert.deepEqual(plan('10.0.0.1', '255.255.255.252'), { base: '10.0.0', start: 1, end: 2 });
  // Wider than a /24: a third octet range.
  assert.deepEqual(plan('172.16.5.9', '255.255.254.0'), { base: '172.16.4-5', start: 1, end: 254 });
  assert.deepEqual(plan('10.0.21.5', '255.255.240.0'), { base: '10.0.16-31', start: 1, end: 254 });
  // Wider than a /20: the /20 that holds the address.
  assert.deepEqual(plan('10.3.40.5', '255.0.0.0'), { base: '10.3.32-47', start: 1, end: 254 });
  assert.equal(plan('not an ip', '255.255.255.0'), null);
  assert.equal(plan('10.0.0.1', ''), null);
});

test('scanBases expands a third octet range, up to a /20', () => {
  assert.deepEqual(Discovery.scanBases(' 192.168.1 '), ['192.168.1']);
  assert.deepEqual(Discovery.scanBases('172.16.4-5'), ['172.16.4', '172.16.5']);
  assert.equal(Discovery.scanBases('10.0.16-31').length, Discovery.MAX_SCAN_BLOCKS);
  assert.equal(Discovery.scanBases('10.0.16-32'), null);
  assert.equal(Discovery.scanBases('10.0.5-4'), null);
  for (const bad of ['', '10.0', '10.0.0.1', '10.0.01', '256.0.0', '10.0.1-', '10.0.1;ls']) {
    assert.equal(Discovery.scanBases(bad), null, bad);
  }
});
