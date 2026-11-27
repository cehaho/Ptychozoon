// Drawing of the canvas: nodes and containers (renderTree), status look of a
// node, container expand/collapse.

import { Probe, SnmpUI, Topology, TopologyCanvas, lucide } from './libs.js';
import {
  escapeHtml,
  safeContainerType,
  safeCssColor,
  safeLucideName,
  sanitizeSvg
} from './util.js';
import { state } from './state.js';
import { saveConfig } from './io.js';
import { CanvasSearch } from './search-ui.js';
import { drawLines } from './canvas-links.js';
import { saveStateForUndo } from './undo.js';

// Grid System

// Position of a node in world pixels. A node without one falls back to a
// place in the tree, centred on the origin.
function nodePosition(node, levels, maxLevel) {
  const x = Number(node.x);
  const y = Number(node.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x: x, y: y };
  const levelNodes = levels[node.level] || [];
  const idx = Math.max(0, levelNodes.indexOf(node));
  return {
    x: (idx - (levelNodes.length - 1) / 2) * 200,
    y: (node.level - maxLevel / 2) * 180
  };
}

// renderTree wires node events to these handlers. main.js sets them: they
// live in modules that redraw the canvas themselves (drag, menu, node form).
const nodeEvents = {
  startDrag: null,
  startConnection: null,
  contextMenu: null,
  open: null
};

export function setNodeEventHandlers(handlers) {
  Object.assign(nodeEvents, handlers);
}

function parentIdOf(nodeId, role) {
  return Topology.parentNodeId(state.config, nodeId, role);
}

export function getGridCell(x, y) {
  return TopologyCanvas.gridCell(x, y);
}

// A node icon given as an image URL disappears when it fails to load.
function hideBrokenImages(el) {
  el.querySelectorAll('img[data-hide-on-error]').forEach((img) => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
    });
  });
}

export function statusView(status) {
  const nodeState = Probe.canonicalStatus(status);
  if (nodeState === 'up') {
    return {
      state: nodeState,
      label: 'ONLINE',
      short: 'ON',
      className: 'online',
      color: 'var(--green)',
      background: 'var(--green-soft)',
      dot: 'bg-green-500',
      text: 'text-green-400'
    };
  }
  if (nodeState === 'down') {
    return {
      state: nodeState,
      label: 'OFFLINE',
      short: 'OFF',
      className: 'offline',
      color: 'var(--red)',
      background: 'var(--red-soft)',
      dot: 'bg-red-500',
      text: 'text-red-400 font-bold'
    };
  }
  return {
    state: nodeState,
    label: 'UNKNOWN',
    short: '…',
    className: 'unknown',
    color: 'var(--faint)',
    background: 'var(--soft)',
    dot: 'bg-slate-400',
    text: 'text-slate-400'
  };
}

export function statusLabel(node, statusById, view) {
  const active = Probe.activeLink(state.config.links, node.id, statusById);
  const label = active && active.role === 'failover' ? view.label + ' · FAILOVER' : view.label;
  // `probeDetail` names the check that failed (or passed) for a node with a `probe`.
  if (node.probeDetail) return `<span title="${escapeHtml(node.probeDetail)}">${label}</span>`;
  return label;
}

export function renderTree(nodes) {
  const container = document.getElementById('tree-container');
  container.innerHTML = '';

  const nodeMap = {};
  const primaryById = {};
  const statusById = new Map();
  nodes.forEach((n) => {
    primaryById[n.id] = parentIdOf(n.id, 'primary');
    n.level = 0;
    nodeMap[n.id] = n;
    statusById.set(n.id, n.status);
  });

  // Calculate levels from primary links. The parent id is not stored on the node.
  for (let i = 0; i < 6; i++) {
    nodes.forEach((n) => {
      const parentId = primaryById[n.id];
      if (parentId && nodeMap[parentId]) {
        n.level = Math.max(n.level, nodeMap[parentId].level + 1);
      }
    });
  }

  const maxLevel = nodes.reduce((m, x) => Math.max(m, x.level || 0), 0);
  const levels = {};
  for (let l = 0; l <= maxLevel; l++) {
    levels[l] = nodes.filter((n) => n.level === l);
  }

  // Helper function to generate ports HTML
  function generatePortsHtml(node) {
    const ports = node.ports || [];
    const portsByPosition = { top: [], bottom: [], left: [], right: [] };
    ports.forEach((port) => {
      if (portsByPosition[port.side]) {
        portsByPosition[port.side].push(port);
      }
    });

    const totalPorts = ports.length;
    const hasMultiplePorts = totalPorts >= 2;

    let portsHtml = '<div class="node-ports">';
    Object.entries(portsByPosition).forEach(([side, sidePorts]) => {
      const count = sidePorts.length;
      sidePorts.forEach((port, idx) => {
        const isConnected = state.config.links.some(
          (c) =>
            (c.sourceNodeId === node.id && c.sourcePortId === port.id) ||
            (c.targetNodeId === node.id && c.targetPortId === port.id)
        );

        let posPercent = 50;
        if (count > 1) {
          posPercent = ((idx + 1) / (count + 1)) * 100;
        }

        let posStyle;
        if (side === 'top' || side === 'bottom') {
          posStyle = `left: ${posPercent}%; transform: translateX(-50%);`;
          if (side === 'top') posStyle += ' top: -6px;';
          else posStyle += ' bottom: -6px;';
        } else {
          posStyle = `top: ${posPercent}%; transform: translateY(-50%);`;
          if (side === 'left') posStyle += ' left: -6px;';
          else posStyle += ' right: -6px;';
        }

        const alwaysVisible = side === 'bottom' || hasMultiplePorts ? 'always-visible' : '';

        portsHtml += `
          <div class="port-handle ${isConnected ? 'connected' : ''}"
               style="${posStyle}"
               data-node-id="${node.id}"
               data-port-id="${port.id}"
               data-side="${side}"
               data-index="${idx}"
               title="${escapeHtml(port.name)}"></div>
          <span class="port-label ${alwaysVisible}" style="${posStyle}">${escapeHtml(port.name)}</span>
        `;
      });
    });
    // A handle on each free side: drawing a link from or to it adds the port.
    TopologyCanvas.freeSides(ports).forEach((side) => {
      const posStyle =
        side === 'top' || side === 'bottom'
          ? `left: 50%; transform: translateX(-50%); ${side}: -6px;`
          : `top: 50%; transform: translateY(-50%); ${side}: -6px;`;
      portsHtml += `
          <div class="port-handle side-handle"
               style="${posStyle}"
               data-node-id="${node.id}"
               data-side="${side}"
               title="Connect on the ${side}"></div>
        `;
    });
    portsHtml += '</div>';
    return portsHtml;
  }

  // Helper function to generate icon HTML
  function generateIconHtml(node) {
    if (node.iconType === 'url') {
      return `<img src="${escapeHtml(node.icon || '')}" class="w-full h-full object-cover" data-hide-on-error>`;
    }
    if (node.iconType === 'svg') {
      return sanitizeSvg(node.icon) || '<i data-lucide="help-circle" class="w-8 h-8"></i>';
    }
    return `<i data-lucide="${safeLucideName(node.icon)}" class="w-8 h-8"></i>`;
  }

  // Separate containers from regular nodes
  const containerNodes = nodes.filter((n) => n.isContainer);
  const childNodes = nodes.filter((n) => n.containerId && !n.isContainer);
  const standaloneNodes = nodes.filter((n) => !n.isContainer && !n.containerId);

  // First, render container nodes
  containerNodes.forEach((node) => {
    const el = document.createElement('div');
    el.id = `node-${node.id}`;
    el.className = `node-container card is-container container-${safeContainerType(node.containerType)}`;
    el.dataset.nodeId = node.id;
    SnmpUI.decorateNode(el, node.id);
    el.dataset.isContainer = 'true';

    // Get children of this container
    const children = childNodes.filter((c) => c.containerId === node.id);
    const isExpanded = node.expanded !== false;

    const position = nodePosition(node, levels, maxLevel);
    el.style.left = position.x + 'px';
    el.style.top = position.y + 'px';
    el.style.pointerEvents = 'auto';

    const view = statusView(node.status);
    const iconHtml = generateIconHtml(node);
    const portsHtml = generatePortsHtml(node);

    // Container type labels
    const containerTypeLabels = {
      proxmox: 'Proxmox',
      docker: 'Docker',
      kubernetes: 'K8s',
      vmware: 'VMware',
      rack: 'Rack',
      cloud: 'Cloud',
      custom: 'Container'
    };

    // Helper function to generate child node HTML
    function generateChildHtml(child, idx) {
      const childView = statusView(child.status);
      const childIconHtml = generateIconHtml(child);
      return `
        <div class="child-node" data-node-id="${child.id}" data-child-index="${idx}">
          <div class="child-node-icon">
            ${childIconHtml}
          </div>
          <div class="child-node-info">
            <div class="child-node-name">${escapeHtml(child.name || child.id)}</div>
            <div class="child-node-address" title="${escapeHtml(child.address || '')}">${escapeHtml(child.address || '')}</div>
          </div>
          <div class="child-node-status ${childView.className}">
            ${childView.short}
          </div>
        </div>
      `;
    }

    // Generate children HTML with VLAN zones support
    let childrenHtml = '';
    const zones = node.zones || [];

    if (isExpanded) {
      if (zones.length > 0) {
        // Group children by zones
        zones.forEach((zone) => {
          const zoneChildren = children.filter((c) => c.zoneId === zone.id);
          const zoneColor = safeCssColor(zone.color);

          childrenHtml += `
            <div class="vlan-zone" data-zone-id="${escapeHtml(zone.id)}">
              <div class="vlan-zone-header" data-toggle-zone="${escapeHtml(zone.id)}">
                <div class="vlan-zone-header-left">
                  <span class="vlan-zone-badge" style="background: ${zoneColor}20; color: ${zoneColor}; border: 1px solid ${zoneColor}40;">
                    VLAN ${escapeHtml(zone.vlanId)}
                  </span>
                  <span class="vlan-zone-name">${escapeHtml(zone.name)}</span>
                </div>
                <span class="vlan-zone-count">${zoneChildren.length} node${zoneChildren.length !== 1 ? 's' : ''}</span>
              </div>
              <div class="vlan-zone-content" id="zone-content-${zone.id}">
                ${
                  zoneChildren.length > 0
                    ? zoneChildren.map((child, idx) => generateChildHtml(child, idx)).join('')
                    : '<div class="vlan-zone-empty">No nodes in this zone</div>'
                }
                <div class="vlan-zone-drop" data-container-id="${node.id}" data-zone-id="${zone.id}">
                  Drop node here
                </div>
              </div>
            </div>
          `;
        });

        // Show unassigned nodes (not in any zone)
        const unassignedNodes = children.filter((c) => !c.zoneId);
        if (unassignedNodes.length > 0) {
          childrenHtml += `
            <div class="vlan-zone">
              <div class="vlan-zone-header">
                <div class="vlan-zone-header-left">
                  <span class="vlan-zone-badge" style="background: var(--soft); color: var(--faint);">
                    DEFAULT
                  </span>
                  <span class="vlan-zone-name">Unassigned</span>
                </div>
                <span class="vlan-zone-count">${unassignedNodes.length} node${unassignedNodes.length !== 1 ? 's' : ''}</span>
              </div>
              <div class="vlan-zone-content">
                ${unassignedNodes.map((child, idx) => generateChildHtml(child, idx)).join('')}
              </div>
            </div>
          `;
        }
      } else if (children.length > 0) {
        // No zones defined, show all children flat
        children.forEach((child, idx) => {
          childrenHtml += generateChildHtml(child, idx);
        });
      }
    }

    el.innerHTML = `
      ${portsHtml}
      <div class="container-header">
        <div class="container-header-left">
          <button class="container-toggle">
            <i data-lucide="${isExpanded ? 'chevron-down' : 'chevron-right'}" class="w-4 h-4"></i>
          </button>
          <div class="container-icon">
            ${iconHtml}
          </div>
          <div class="container-title">
            <div class="container-name">${escapeHtml(node.name || node.id)}</div>
            <div class="container-type-badge">${containerTypeLabels[node.containerType] || 'Container'}</div>
          </div>
        </div>
        <div class="container-header-right">
          <span class="container-count">${children.length} node${children.length !== 1 ? 's' : ''}</span>
          <div class="container-status ${view.className}">
            ${statusLabel(node, statusById, view)}
          </div>
        </div>
      </div>
      <div class="container-content ${isExpanded ? '' : 'collapsed'}">
        ${childrenHtml || '<div class="container-empty">Drop nodes here or create new ones</div>'}
        ${
          zones.length === 0
            ? `
          <div class="container-drop-zone" data-container-id="${node.id}">
            <i data-lucide="plus" class="w-4 h-4"></i>
            <span>Drop node here</span>
          </div>
        `
            : ''
        }
      </div>
    `;

    // Event listeners for container
    hideBrokenImages(el);
    el.querySelector('.container-toggle').addEventListener('click', () =>
      toggleContainerExpand(node.id)
    );
    el.querySelectorAll('[data-toggle-zone]').forEach((header) => {
      header.addEventListener('click', () =>
        toggleZoneCollapse(node.id, header.dataset.toggleZone)
      );
    });
    el.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('port-handle')) return;
      if (e.target.closest('.container-toggle')) return;
      if (e.target.closest('.child-node')) return;
      nodeEvents.startDrag(e, node);
    });
    el.addEventListener('contextmenu', (e) => nodeEvents.contextMenu(e, node));
    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.child-node') && !e.target.closest('.container-toggle')) {
        nodeEvents.open(node);
      }
    });

    // Child node event listeners
    el.querySelectorAll('.child-node').forEach((childEl) => {
      const childId = childEl.dataset.nodeId;
      const childNode = children.find((c) => c.id === childId);
      if (childNode) {
        childEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          nodeEvents.open(childNode);
        });
        childEl.addEventListener('contextmenu', (e) => {
          e.stopPropagation();
          nodeEvents.contextMenu(e, childNode);
        });
      }
    });

    // Port event listeners
    el.querySelectorAll('.port-handle').forEach((portEl) => {
      portEl.addEventListener('mousedown', (e) => nodeEvents.startConnection(e, node, portEl));
    });

    container.appendChild(el);
  });

  // Then render standalone nodes (not in any container)
  standaloneNodes.forEach((node) => {
    const el = document.createElement('div');
    el.id = `node-${node.id}`;
    el.className = 'node-container card';
    el.dataset.nodeId = node.id;
    SnmpUI.decorateNode(el, node.id);

    const position = nodePosition(node, levels, maxLevel);
    el.style.left = position.x + 'px';
    el.style.top = position.y + 'px';
    el.style.width = '140px';
    el.style.height = '140px';
    el.style.pointerEvents = 'auto';

    const view = statusView(node.status);
    const iconHtml = generateIconHtml(node);
    const gridCell = getGridCell(position.x, position.y);
    const portsHtml = generatePortsHtml(node);

    el.innerHTML = `
      ${portsHtml}
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:6px; padding:10px; box-sizing:border-box;">
        <div style="width:48px; height:48px; border-radius:999px; display:flex; align-items:center; justify-content:center; background: var(--soft); border:1px solid var(--border); color: var(--muted); overflow:hidden;">
          ${iconHtml}
        </div>
        <div style="text-align:center; width:100%; color:var(--text);">
          <div style="font-weight:700; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(node.name || node.id)}</div>
          <div style="font-size:11px; color:var(--muted); font-family:var(--font-mono); font-variant-numeric:tabular-nums;">${escapeHtml(node.address || '')}</div>
          <div style="font-size:9px; color:var(--faint); font-family:var(--font-mono);">${gridCell.col}${gridCell.row}</div>
          <div style="margin-top:6px; font-size:10px; padding:4px 6px; border-radius:999px; display:inline-block; color:${view.color}; background:${view.background}; font-weight:700; letter-spacing:0.05em;">
            ${statusLabel(node, statusById, view)}
          </div>
        </div>
      </div>
    `;

    // Event listeners for node interaction
    hideBrokenImages(el);
    el.addEventListener('mousedown', (e) => {
      // Don't start node drag if clicking on a port
      if (e.target.classList.contains('port-handle')) return;
      nodeEvents.startDrag(e, node);
    });
    el.addEventListener('contextmenu', (e) => nodeEvents.contextMenu(e, node));
    el.addEventListener('dblclick', () => nodeEvents.open(node));

    // Port event listeners
    el.querySelectorAll('.port-handle').forEach((portEl) => {
      portEl.addEventListener('mousedown', (e) => nodeEvents.startConnection(e, node, portEl));
    });

    container.appendChild(el);
  });

  lucide.createIcons();
  CanvasSearch.decorate();
  requestAnimationFrame(drawLines);
}

// Toggle container expand/collapse
export function toggleContainerExpand(nodeId) {
  const node = state.config.nodes.find((n) => n.id === nodeId);
  if (node && node.isContainer) {
    saveStateForUndo(node.expanded ? `Collapse "${node.name}"` : `Expand "${node.name}"`);
    node.expanded = !node.expanded;
    renderTree(state.config.nodes);
    saveConfig();
  }
}

// Toggle VLAN zone collapse
function toggleZoneCollapse(containerId, zoneId) {
  const zoneContent = document.getElementById(`zone-content-${zoneId}`);
  if (zoneContent) {
    zoneContent.classList.toggle('collapsed');
  }
}
