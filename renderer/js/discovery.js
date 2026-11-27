// Discovery helpers: suggested node names and icons from reverse DNS and
// MAC vendor, deduplication against the canvas, and placement of new nodes.
//
// Pure functions only. app/discovery-ui.js owns the dialog and the document;
// positions are world pixels (see canvas.js), so the canvas has no edge.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.Discovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PRIVATE_VENDOR = 'Private/random';
  // Fingerprints from `network_identify` (src-tauri/src/identify.rs) and the
  // Lucide icon each kind gets.
  const DEVICE_ICONS = {
    unifi: 'router',
    airmax: 'wifi',
    edge: 'router',
    proxmox: 'server'
  };
  // Placement in world pixels. The canvas is endless, so there is no edge to
  // stop at; the ring grows until every host has a free cell.
  const PLACE_STEP_X = 200;
  const PLACE_STEP_Y = 200;
  const MIN_GAP = 160; // a new node keeps this distance from existing ones
  const MAX_RING = 500;

  // Vendor and hostname hints, checked in order. Icons are Lucide names.
  const ICON_RULES = [
    {
      icon: 'printer',
      vendor: /\b(brother|canon|epson|lexmark|xerox|kyocera|ricoh|konica|sharp)\b/i,
      host: /\b(printer|print|prn|mfp)\b/i
    },
    {
      icon: 'cctv',
      vendor: /\b(hikvision|dahua|axis communications|reolink|hanwha|vivotek|mobotix)\b/i,
      host: /\b(cam|camera|ipcam|nvr|dvr)\b/i
    },
    {
      icon: 'hard-drive',
      vendor: /\b(synology|qnap|western digital|seagate|buffalo|asustor|netapp)\b/i,
      host: /\b(nas|storage|backup)\b/i
    },
    {
      icon: 'router',
      vendor:
        /\b(cisco|juniper|mikrotik|routerboard|ubiquiti|netgear|tp-link|tp link|sagemcom|avm|arcadyan|zyxel|draytek|fortinet|palo alto|aruba|ruckus|technicolor|huawei|zte|sercomm|arris|commscope|linksys|d-link)\b/i,
      host: /\b(router|gw|gateway|fw|firewall|switch|sw|ap|wap|livebox|freebox|fritz)\b/i
    },
    {
      icon: 'server',
      vendor:
        /\b(vmware|supermicro|dell|hewlett|hpe|lenovo|proxmox|nutanix|xensource|qemu|parallels)\b/i,
      host: /\b(srv|server|esx|esxi|pve|proxmox|hyperv|vm|db|sql|web|mail|dns|dc)\b/i
    },
    {
      icon: 'cpu',
      vendor: /\b(raspberry|espressif|arduino|particle|tuya|shelly|sonoff|itead|silicon labs)\b/i,
      host: /\b(pi|rpi|raspberrypi|esp|iot|sensor|plug)\b/i
    },
    {
      icon: 'tv',
      vendor: /\b(roku|lg electronics|vizio|tcl|hisense|nvidia|chromecast)\b/i,
      host: /\b(tv|chromecast|roku|shield|appletv)\b/i
    },
    {
      icon: 'speaker',
      vendor: /\b(sonos|bose|harman|denon|yamaha)\b/i,
      host: /\b(sonos|speaker|echo|homepod)\b/i
    },
    {
      icon: 'smartphone',
      vendor: /\b(oneplus|oppo|vivo|realme|motorola mobility|xiaomi)\b/i,
      host: /\b(phone|iphone|android|pixel|galaxy)\b/i
    },
    {
      icon: 'laptop',
      vendor:
        /\b(apple|intel corporate|liteon|azurewave|hon hai|quanta|compal|wistron|pegatron)\b/i,
      host: /\b(laptop|macbook|notebook|desktop|pc|workstation|imac)\b/i
    }
  ];

  function isIpLiteral(text) {
    const value = String(text || '');
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
  }

  // Canonical address text for comparison: trimmed, unbracketed, lower-case,
  // an IPv6 literal compressed (RFC 5952 via URL) with its zone kept.
  function canonicalAddress(address) {
    let text = String(address || '')
      .trim()
      .toLowerCase();
    if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
    if (!text.includes(':')) return text;
    const index = text.indexOf('%');
    const bare = index === -1 ? text : text.slice(0, index);
    const zone = index === -1 ? '' : text.slice(index);
    try {
      return new URL('http://[' + bare + ']/').hostname.slice(1, -1) + zone;
    } catch (error) {
      return text;
    }
  }

  // "nas.home.lan" -> "nas". Empty for an address or nothing.
  function shortHostName(hostname) {
    const text = String(hostname || '')
      .trim()
      .replace(/\.$/, '');
    if (!text || isIpLiteral(text)) return '';
    return text.split('.')[0];
  }

  function usableVendor(vendor) {
    const text = String(vendor || '').trim();
    return text && text !== PRIVATE_VENDOR ? text : '';
  }

  // Last IPv4 octet or last IPv6 group: "192.168.1.42" -> "42".
  function addressSuffix(ip) {
    const text = String(ip || '').split('%')[0];
    const parts = text.includes(':') ? text.split(':') : text.split('.');
    return parts[parts.length - 1] || text;
  }

  // PTR short name, else "<device> <last octet>", else "<vendor> <last
  // octet>", else "Device <ip>".
  function suggestName(host) {
    const entry = host || {};
    const short = shortHostName(entry.hostname);
    if (short) return short;
    const device = String(entry.device || '').trim();
    if (device) return device + ' ' + addressSuffix(entry.ip);
    const vendor = usableVendor(entry.vendor);
    if (vendor) return vendor + ' ' + addressSuffix(entry.ip);
    return 'Device ' + String(entry.ip || '');
  }

  // A Lucide icon name from hostname keywords first, then the vendor.
  function suggestIcon(host) {
    const entry = host || {};
    const words = shortHostName(entry.hostname)
      .replace(/[-_]+/g, ' ')
      .replace(/(\D)(\d)/g, '$1 $2');
    if (words) {
      const byHost = ICON_RULES.find((rule) => rule.host.test(words));
      if (byHost) return byHost.icon;
    }
    const byDevice = DEVICE_ICONS[entry.deviceKind];
    if (byDevice) return byDevice;
    const vendor = usableVendor(entry.vendor);
    if (vendor) {
      const byVendor = ICON_RULES.find((rule) => rule.vendor.test(vendor));
      if (byVendor) return byVendor.icon;
    }
    return 'circle';
  }

  // Hosts worth a fingerprint: a Ubiquiti or Proxmox vendor, or a host name
  // that names one of their products. A host already identified is skipped.
  const IDENTIFY_VENDOR = /\b(ubiquiti|unifi|proxmox)\b/i;
  const IDENTIFY_HOST = /\b(unifi|proxmox|pve|ap|uap|usw|udm)\b/i;
  function identifyCandidate(host) {
    const entry = host || {};
    if (entry.deviceKind) return false;
    const vendor = usableVendor(entry.vendor);
    if (vendor && IDENTIFY_VENDOR.test(vendor)) return true;
    const words = shortHostName(entry.hostname).replace(/[-_]+/g, ' ');
    return Boolean(words) && IDENTIFY_HOST.test(words);
  }

  // Hosts whose address is not already a node (nor repeated in the list).
  function newHosts(hosts, nodes) {
    const seen = new Set(
      (nodes || []).map((node) => canonicalAddress(node && node.address)).filter(Boolean)
    );
    const out = [];
    (hosts || []).forEach((host) => {
      if (!host || !host.ip) return;
      const key = canonicalAddress(host.ip);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(host);
    });
    return out;
  }

  // `count` positions on a grid around `center`, filled ring by ring
  // (nearest cells first), skipping cells within MIN_GAP of an existing node.
  function placeNear(center, count, existing) {
    const cx = Number.isFinite(Number(center && center.x)) ? Number(center.x) : 0;
    const cy = Number.isFinite(Number(center && center.y)) ? Number(center.y) : 0;
    const taken = (existing || [])
      .filter((node) => node && Number.isFinite(node.x) && Number.isFinite(node.y))
      .map((node) => ({ x: node.x, y: node.y }));
    const free = (x, y) =>
      taken.every((p) => Math.abs(p.x - x) >= MIN_GAP || Math.abs(p.y - y) >= MIN_GAP);
    const positions = [];
    for (let ring = 0; positions.length < count && ring <= MAX_RING; ring += 1) {
      const cells = [];
      for (let row = -ring; row <= ring; row += 1) {
        for (let col = -ring; col <= ring; col += 1) {
          if (Math.max(Math.abs(row), Math.abs(col)) !== ring) continue;
          cells.push({ row: row, col: col });
        }
      }
      // Row by row, left to right, so a batch reads like a grid.
      cells.sort((a, b) => a.row - b.row || a.col - b.col);
      for (const cell of cells) {
        if (positions.length >= count) break;
        const x = cx + cell.col * PLACE_STEP_X;
        const y = cy + cell.row * PLACE_STEP_Y;
        if (!free(x, y)) continue;
        const point = { x: Math.round(x), y: Math.round(y) };
        positions.push(point);
        taken.push(point);
      }
    }
    // Canvas full: stack the rest on the centre rather than drop them.
    while (positions.length < count) positions.push({ x: cx, y: cy });
    return positions;
  }

  // Node fields (world pixel positions) for the selected hosts that are not on
  // the canvas yet:
  // { name, address, mac?, icon, iconType, x, y }. `host.name` (edited in
  // the dialog) wins over the suggestion.
  function nodesForHosts(hosts, nodes, center) {
    const fresh = newHosts(hosts, nodes);
    const positions = placeNear(center, fresh.length, nodes);
    return fresh.map((host, index) => {
      const node = {
        name: String(host.name || '').trim() || suggestName(host),
        address: host.ip,
        icon: suggestIcon(host),
        iconType: 'lucide',
        x: positions[index].x,
        y: positions[index].y
      };
      if (host.mac) node.mac = String(host.mac).toLowerCase();
      return node;
    });
  }

  // A scan covers whole /24 blocks: at most MAX_SCAN_BLOCKS of them (a /20).
  const MAX_SCAN_BLOCKS = 16;
  const OCTET_TEXT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  const SCAN_BASE_RE = new RegExp(
    `^(${OCTET_TEXT})\\.(${OCTET_TEXT})\\.(${OCTET_TEXT})(?:-(${OCTET_TEXT}))?$`
  );

  function ipv4Number(text) {
    const parts = String(text || '').split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
      value = value * 256 + Number(part);
    }
    return value;
  }

  // Form values for the network of an interface: `base` is `a.b.c` or, for a
  // network wider than a /24, `a.b.c-d` (third octet range); start and end
  // are the last octet. A network wider than a /20 is cut to the /20 that
  // holds the interface address.
  function scanPlan(address, netmask) {
    const ip = ipv4Number(address);
    const mask = ipv4Number(netmask);
    if (ip === null || mask === null) return null;
    let prefix = 0;
    while (prefix < 32 && Math.floor(mask / 2 ** (31 - prefix)) % 2 === 1) prefix += 1;
    const width = 2 ** (32 - Math.max(prefix, 20));
    const network = ip - (ip % width);
    const octets = [24, 16, 8, 0].map((shift) => Math.floor(network / 2 ** shift) % 256);
    const head = `${octets[0]}.${octets[1]}.${octets[2]}`;
    if (width <= 256) {
      // A /24 or narrower: hosts between the network and broadcast addresses.
      const start = width >= 4 ? octets[3] + 1 : octets[3];
      const end = width >= 4 ? octets[3] + width - 2 : octets[3] + width - 1;
      return { base: head, start: Math.max(start, 1), end: Math.min(end, 254) };
    }
    const last = octets[2] + width / 256 - 1;
    return { base: `${head}-${last}`, start: 1, end: 254 };
  }

  // The /24 bases (`a.b.c`) named by the base field, or null when it is not
  // `a.b.c` or `a.b.c-d` with c <= d and at most MAX_SCAN_BLOCKS blocks.
  function scanBases(text) {
    const match = SCAN_BASE_RE.exec(String(text || '').trim());
    if (!match) return null;
    const first = Number(match[3]);
    const last = match[4] === undefined ? first : Number(match[4]);
    if (last < first || last - first + 1 > MAX_SCAN_BLOCKS) return null;
    const bases = [];
    for (let third = first; third <= last; third += 1) {
      bases.push(`${match[1]}.${match[2]}.${third}`);
    }
    return bases;
  }

  return {
    MAX_SCAN_BLOCKS: MAX_SCAN_BLOCKS,
    scanPlan: scanPlan,
    scanBases: scanBases,
    PRIVATE_VENDOR: PRIVATE_VENDOR,
    canonicalAddress: canonicalAddress,
    shortHostName: shortHostName,
    suggestName: suggestName,
    suggestIcon: suggestIcon,
    identifyCandidate: identifyCandidate,
    newHosts: newHosts,
    placeNear: placeNear,
    nodesForHosts: nodesForHosts
  };
});
