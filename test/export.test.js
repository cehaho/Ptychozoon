'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Export = require('../renderer/js/export.js');

function scene() {
  return {
    nodes: [
      {
        id: 'a',
        x: 100,
        y: 200,
        width: 140,
        height: 140,
        name: '<b>R&"c"</b>',
        address: '10.0.0.1',
        cell: 'B4',
        status: { color: '#5fb85a', label: 'ONLINE', short: 'ON' },
        icon: {
          kind: 'svg',
          tree: {
            tag: 'svg',
            attrs: {
              viewBox: '0 0 24 24',
              stroke: 'currentColor',
              fill: 'none',
              onload: 'alert(1)',
              class: 'lucide'
            },
            children: [
              {
                tag: 'path',
                attrs: { d: 'M3 12h18', onclick: 'x()', style: 'fill:red' },
                children: []
              },
              { tag: 'script', attrs: {}, children: [] },
              { tag: 'image', attrs: { href: 'https://example.com/x.png' }, children: [] },
              {
                tag: 'rect',
                attrs: { x: '1', y: '1', width: '4', height: '4', fill: 'url(https://evil/x)' },
                children: []
              }
            ]
          }
        }
      },
      {
        id: 'b',
        x: 600,
        y: 500,
        width: 140,
        height: 140,
        name: 'Server',
        address: '',
        status: { color: 'red;stroke:url(x)', label: 'OFFLINE' },
        icon: { kind: 'letter' }
      }
    ],
    containers: [
      {
        id: 'c',
        x: -300,
        y: 50,
        width: 320,
        height: 240,
        headerHeight: 52,
        name: 'Proxmox <host>',
        typeLabel: 'Proxmox',
        count: '1 node',
        status: { color: '#8a8a8a', label: 'UNKNOWN' },
        icon: null,
        zones: [
          {
            x: -290,
            y: 110,
            width: 300,
            height: 120,
            name: 'Lab',
            badge: 'VLAN 10',
            color: '#4d9fea',
            count: '1 node'
          }
        ],
        children: [
          {
            x: -280,
            y: 140,
            width: 280,
            height: 40,
            name: 'vm1',
            address: '10.0.0.5',
            status: { color: '#5fb85a', short: 'ON' }
          }
        ]
      }
    ],
    links: [
      { d: 'M 170 340 C 170 400, 670 440, 670 500', color: '#5fb85a', opacity: '0.45', dash: null },
      { d: 'M0 0 L10 10" onload="x', color: '#5fb85a' }
    ],
    linkLabels: [
      {
        x: 400,
        y: 412,
        width: 70,
        height: 16,
        textX: 435,
        textY: 424,
        text: 'fiber <10G>',
        color: '#5fb85a'
      }
    ]
  };
}

test('node names and labels are escaped', () => {
  const { svg } = Export.buildSvg(scene(), { theme: 'dark' });
  assert.ok(svg.includes('&lt;b&gt;R&amp;&quot;c&quot;&lt;/b&gt;'));
  assert.ok(svg.includes('Proxmox &lt;host&gt;'));
  assert.ok(svg.includes('fiber &lt;10G&gt;'));
  assert.ok(!svg.includes('<b>'));
  assert.equal(Export.escapeXml('a\u0001b'), 'ab');
});

test('the viewBox covers every node, container, label and link with padding', () => {
  const built = Export.buildSvg(scene(), { padding: 40 });
  // Left: container at -300; top: container at 50; right: node b 600+140;
  // bottom: node b 500+140. The rejected link path does not count.
  assert.deepEqual(built.bounds, { x: -340, y: 10, width: 1120, height: 670 });
  assert.match(built.svg, /viewBox="-340 10 1120 670"/);
  assert.match(built.svg, /width="1120" height="670"/);
});

test('bezier control points extend the bounds', () => {
  const bounds = Export.computeBounds({ links: [{ d: 'M 0 0 C 0 -500, 100 -500, 100 0' }] }, 10);
  assert.deepEqual(bounds, { x: -10, y: -510, width: 120, height: 520 });
  assert.deepEqual(Export.computeBounds({}, 10), { x: 0, y: 0, width: 20, height: 20 });
});

test('the output has no script, event handler, external reference or foreignObject', () => {
  const { svg } = Export.buildSvg(scene(), { theme: 'light' });
  assert.ok(!/<script/i.test(svg));
  assert.ok(!/\son\w+\s*=/i.test(svg), 'no on* attribute');
  assert.ok(!/href|url\(|https?:\/\/(?!www\.w3\.org)/i.test(svg), 'no external reference');
  assert.ok(!/foreignObject|<image/i.test(svg));
  assert.ok(!/style="/i.test(svg), 'no inline style attribute from icons');
  assert.ok(svg.includes('<path d="M3 12h18"/>'), 'the icon path is kept');
  assert.ok(!svg.includes('M0 0 L10 10'), 'a tampered link path is dropped');
  assert.ok(svg.includes('stroke="#292724"'), 'currentColor becomes the theme text colour');
  assert.ok(!/red;stroke/.test(svg), 'an unsafe colour falls back');
});

test('styles are embedded and the background follows the theme', () => {
  const dark = Export.buildSvg(scene(), { theme: 'dark' }).svg;
  const light = Export.buildSvg(scene(), { theme: 'light' }).svg;
  assert.match(dark, /<style>[^<]*\.name\{/);
  assert.ok(dark.includes('fill="' + Export.THEMES.dark.background + '"'));
  assert.ok(light.includes('fill="' + Export.THEMES.light.background + '"'));
  assert.ok(
    dark.startsWith(
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"'
    )
  );
});

test('zones, children and fallback icons are drawn', () => {
  const { svg } = Export.buildSvg(scene(), {});
  assert.ok(svg.includes('VLAN 10 · Lab'));
  assert.ok(svg.includes('>vm1</text>'));
  assert.ok(svg.includes('>S</text>'), 'letter icon for Server');
  assert.ok(svg.includes('>P</text>'), 'letter icon for the container without one');
});

test('icon sanitiser keeps only drawing elements', () => {
  const out = Export.sanitizeIconChildren(
    [
      {
        tag: 'g',
        attrs: { transform: 'translate(1 2)' },
        children: [{ tag: 'circle', attrs: { cx: '1', cy: '2', r: '3' } }]
      },
      { tag: 'use', attrs: { href: '#x' } },
      { tag: 'path', attrs: { d: 'M0 0', fill: 'javascript(1)' } }
    ],
    '#fff'
  );
  assert.equal(
    out,
    '<g transform="translate(1 2)"><circle cx="1" cy="2" r="3"/></g><path d="M0 0"/>'
  );
});

test('backup flows keep their arrow, colour and caption', () => {
  const flowScene = {
    nodes: scene().nodes,
    flows: [
      { d: 'M 100 100 Q 200 20 300 100', color: '#5fb85a' },
      { d: 'M 0 0 L10 10" onload="x', color: '#5fb85a' }
    ],
    flowLabels: [
      {
        x: 180,
        y: 40,
        width: 90,
        height: 18,
        textX: 225,
        textY: 53,
        text: 'Backup <nightly> · 2 h ago',
        color: '#e08a3c'
      }
    ]
  };
  const { svg } = Export.buildSvg(flowScene, { theme: 'dark' });
  assert.match(svg, /<g class="flows">/);
  assert.match(svg, /<marker id="flow-arrow-0"[^>]*viewBox="0 0 10 10"/);
  assert.match(svg, /stroke-dasharray="1 6" marker-end="url\(#flow-arrow-0\)"/);
  assert.ok(!svg.includes('L10 10'), 'a tampered flow path is dropped');
  assert.match(svg, /class="flow-label"[^>]*>Backup &lt;nightly&gt; · 2 h ago<\/text>/);
  assert.ok(
    svg.indexOf('<g class="flows">') < svg.indexOf('<g class="nodes">'),
    'arrows stay under the cards'
  );
  assert.ok(
    svg.indexOf('<g class="flow-labels">') > svg.indexOf('<g class="nodes">'),
    'captions stay above the cards'
  );
});

test('the flow collection reads the canvas layers and drops a broken arrow', () => {
  function fakeEl(attrs, found) {
    return {
      attrs: attrs || {},
      found: found || {},
      textContent: '',
      getAttribute(name) {
        return this.attrs[name] === undefined ? null : this.attrs[name];
      },
      querySelector(selector) {
        return this.found[selector] || null;
      },
      querySelectorAll(selector) {
        return this.found[selector] || [];
      }
    };
  }

  const arrow = fakeEl({
    d: 'M 0 0 Q 50 -30 100 0',
    stroke: '#5fb85a',
    'stroke-dasharray': '1 6'
  });
  const broken = fakeEl({ d: 'M0 0 L10 10" onload="x', stroke: '#e5674f' });
  const layer = fakeEl(
    {},
    {
      'g.flow-group': [fakeEl({}, { '.flow-path': arrow }), fakeEl({}, { '.flow-path': broken })]
    }
  );
  const bg = fakeEl({ x: '10', y: '20', width: '90', height: '18', stroke: '#e08a3c' });
  const label = fakeEl({ x: '55', y: '33' });
  label.textContent = 'Backup <nightly> · 2 h ago';
  const overlay = fakeEl({}, { 'g.flow-caption': [fakeEl({}, { rect: bg, text: label })] });

  const collected = Export.collectFlows(layer, overlay);
  assert.deepEqual(collected.flows, [{ d: 'M 0 0 Q 50 -30 100 0', color: '#5fb85a', dash: '1 6' }]);
  assert.deepEqual(collected.flowLabels, [
    {
      x: 10,
      y: 20,
      width: 90,
      height: 18,
      color: '#e08a3c',
      textX: 55,
      textY: 33,
      text: 'Backup <nightly> · 2 h ago'
    }
  ]);
  assert.deepEqual(Export.collectFlows(null, null), { flows: [], flowLabels: [] });
});

test('the viewBox covers backup flow arrows and captions', () => {
  const bounds = Export.computeBounds(
    {
      flows: [{ d: 'M 0 0 Q 50 -40 100 0' }],
      flowLabels: [{ x: 10, y: -60, width: 40, height: 18 }]
    },
    10
  );
  assert.deepEqual(bounds, { x: -10, y: -70, width: 120, height: 80 });
});

test('PNG size honours the scale and the canvas limits', () => {
  assert.deepEqual(Export.pngSize(800, 600, 2), { width: 1600, height: 1200, scale: 2 });
  assert.deepEqual(Export.pngSize(800, 600, 1), { width: 800, height: 600, scale: 1 });
  const huge = Export.pngSize(20000, 1000, 2);
  assert.ok(huge.width <= 16384 && huge.scale < 1);
});

test('file names carry the date and format', () => {
  const date = new Date('2026-11-14T10:00:00Z');
  assert.equal(Export.exportFileName('svg', date), 'topology-2026-11-14.svg');
  assert.equal(Export.exportFileName('png', date), 'topology-2026-11-14.png');
  assert.equal(Export.exportFileName('exe', date), 'topology-2026-11-14.png');
});

test('long names are shortened', () => {
  assert.equal(Export.truncate('abcdefghij', 5), 'abcd…');
  assert.equal(Export.truncate('abc', 5), 'abc');
});

test('the page loads export.js before the app modules', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const at = html.indexOf('src="js/export.js"');
  assert.ok(at > 0);
  assert.ok(at < html.indexOf('<script type="module" src="js/app/main.js">'));
});

test('image export is wired through a dialog command, not a blob download', () => {
  const root = path.join(__dirname, '..');
  const appDir = path.join(root, 'renderer', 'js', 'app');
  const app = fs
    .readdirSync(appDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => fs.readFileSync(path.join(appDir, file), 'utf8'))
    .join('\n');
  assert.match(app, /TopologyExport\.exportImage\(/);
  const desktop = fs.readFileSync(path.join(root, 'renderer', 'js', 'desktop.js'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'src-tauri', 'build.rs'), 'utf8');
  const caps = JSON.parse(
    fs.readFileSync(path.join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8')
  );
  assert.ok(!/a\.download\s*=/.test(app), 'no <a download> left in the app modules');
  assert.match(desktop, /invoke\('image_export', \{ format, data, fileName \}\)/);
  assert.ok(build.includes('"image_export"'));
  assert.ok(caps.permissions.includes('allow-image-export'));
});
