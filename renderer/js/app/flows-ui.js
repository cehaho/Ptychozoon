// Backup flows on the canvas: the list and the editor, the arrows drawn over
// the links, and the periodic check (every ten minutes while monitoring runs,
// or on demand). The model and the captions are in flows.js; the checks run
// in the backend (flows_check), which reads the saved topology.

import { AppDialog, Flows } from './libs.js';
import { escapeHtml } from './util.js';
import { state } from './state.js';
import { closeModal, onAction, openModal, toastError, toastSuccess } from './ui.js';
import { saveConfig } from './io.js';
import { saveStateForUndo } from './undo.js';
import { getWorld } from './viewport.js';
import { drawLines } from './canvas-links.js';

const CHECK_EVERY_MS = 10 * 60 * 1000;
const NOT_APPROVED = 'Command not approved';
const COLORS = { ok: '#5fb85a', late: '#e08a3c', failed: '#e5674f', unknown: '#8a8a8a' };
const SVG = 'http://www.w3.org/2000/svg';

// Latest result per flow id: { state, last, detail, checkedAt }.
const results = new Map();
// Last state per flow id, for the notifications.
const notified = new Map();
let timer = null;
let checking = false;
// Flow being edited (null for a new one), and its command as loaded.
let editingId = null;
let loadedCommand = '';

function flows() {
  if (!Array.isArray(state.config.flows)) state.config.flows = [];
  return state.config.flows;
}

function nodeName(id) {
  const node = state.config.nodes.find((n) => n.id === id);
  return node ? node.name || node.address || id : 'Missing node';
}

export function flowsVisible() {
  return !state.config.settings || state.config.settings.showFlows !== false;
}

function hasChecks() {
  return flows().some((flow) => flow.check && flow.check.type !== 'none');
}

// ---------------------------------------------------------------- checks

export async function checkFlows(ids) {
  const api = window.desktopAPI && window.desktopAPI.flows;
  if (!api || checking) return;
  checking = true;
  setChecking(true);
  try {
    const reply = await api.check(ids || null);
    const list = reply && Array.isArray(reply.results) ? reply.results : [];
    list.forEach((result) => results.set(result.id, result));
    notify(Flows.transitions(notified, list, flows()));
  } catch (error) {
    console.warn('Backup flow check failed:', error);
    toastError('Backup check failed', String((error && error.message) || error));
  } finally {
    checking = false;
    setChecking(false);
  }
  refreshFlowList();
  requestAnimationFrame(drawLines);
}

function notify(notes) {
  const settings = state.config.settings || {};
  const api = window.desktopAPI && window.desktopAPI.alerts;
  if (!api || settings.alertsEnabled === false) return;
  notes.forEach((note) => {
    Promise.resolve(api.notify(note.title, note.body)).catch((error) => {
      console.warn('Notification failed:', error);
    });
  });
}

function setChecking(busy) {
  document.querySelectorAll('[data-action="check-flows"]').forEach((button) => {
    button.disabled = busy;
  });
}

export function startFlowChecks() {
  stopFlowChecks();
  if (hasChecks()) checkFlows();
  timer = setInterval(() => {
    if (hasChecks()) checkFlows();
  }, CHECK_EVERY_MS);
}

export function stopFlowChecks() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------------------------------------------------------------- canvas

// Node box in world coordinates; a child of a collapsed container stands
// in for its container.
function nodeBox(id, worldRect) {
  let el = document.getElementById(`node-${id}`);
  if (!el || el.getClientRects().length === 0) {
    const node = state.config.nodes.find((n) => n.id === id);
    el = node && node.containerId ? document.getElementById(`node-${node.containerId}`) : null;
  }
  if (!el || el.getClientRects().length === 0) return null;
  const rect = el.getBoundingClientRect();
  return {
    x: (rect.left + rect.width / 2 - worldRect.left) / state.scale,
    y: (rect.top + rect.height / 2 - worldRect.top) / state.scale,
    width: rect.width / state.scale,
    height: rect.height / state.scale
  };
}

function arrowMarkers(svg) {
  const defs = document.createElementNS(SVG, 'defs');
  Object.entries(COLORS).forEach(([name, color]) => {
    const marker = document.createElementNS(SVG, 'marker');
    marker.setAttribute('id', `flow-arrow-${name}`);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    const tip = document.createElementNS(SVG, 'path');
    tip.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    tip.setAttribute('fill', color);
    marker.appendChild(tip);
    defs.appendChild(marker);
  });
  svg.appendChild(defs);
}

// Draws the flows into the links layer (called at the end of drawLines).
export function drawFlows(svg) {
  const overlay = document.getElementById('flows-label-layer');
  if (overlay) overlay.innerHTML = '';
  if (!flowsVisible() || flows().length === 0) return;
  const world = getWorld();
  if (!world) return;
  const worldRect = world.getBoundingClientRect();
  arrowMarkers(svg);
  const lanes = new Map();
  const now = Date.now();
  flows().forEach((flow) => {
    const from = nodeBox(flow.sourceNodeId, worldRect);
    const to = nodeBox(flow.targetNodeId, worldRect);
    if (!from || !to) return;
    const pair = `${flow.sourceNodeId}>${flow.targetNodeId}`;
    const lane = lanes.get(pair) || 0;
    lanes.set(pair, lane + 1);
    const result = results.get(flow.id);
    const flowState = Flows.stateOf(result);
    const color = COLORS[flowState];
    const geometry = Flows.arrowPath(from, to, lane);

    const group = document.createElementNS(SVG, 'g');
    group.classList.add('flow-group', `flow-${flowState}`);
    group.dataset.flowId = flow.id;
    group.style.pointerEvents = 'auto';

    const hitbox = document.createElementNS(SVG, 'path');
    hitbox.setAttribute('d', geometry.d);
    hitbox.classList.add('flow-hitbox');
    group.appendChild(hitbox);

    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', geometry.d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-dasharray', '1 6');
    path.setAttribute('marker-end', `url(#flow-arrow-${flowState})`);
    path.classList.add('flow-path');
    group.appendChild(path);

    const tooltip = document.createElementNS(SVG, 'title');
    tooltip.textContent = flowTooltip(flow, result);
    group.appendChild(tooltip);
    group.addEventListener('click', (event) => {
      event.stopPropagation();
      openFlowEditor(flow.id);
    });
    svg.appendChild(group);

    // The caption goes above the nodes, so a card never hides it.
    const caption = document.createElementNS(SVG, 'g');
    caption.classList.add('flow-caption', `flow-${flowState}`);
    caption.style.pointerEvents = 'auto';
    const text = Flows.caption(flow, result, now);
    const width = text.length * 6.1 + 14;
    const bg = document.createElementNS(SVG, 'rect');
    bg.setAttribute('x', geometry.labelX - width / 2);
    bg.setAttribute('y', geometry.labelY - 9);
    bg.setAttribute('width', width);
    bg.setAttribute('height', 18);
    bg.setAttribute('rx', 3);
    bg.setAttribute('stroke', color);
    bg.classList.add('flow-label-bg');
    caption.appendChild(bg);

    const label = document.createElementNS(SVG, 'text');
    label.setAttribute('x', geometry.labelX);
    label.setAttribute('y', geometry.labelY + 3.5);
    label.setAttribute('text-anchor', 'middle');
    label.classList.add('flow-label');
    label.textContent = text;
    caption.appendChild(label);

    const captionTip = document.createElementNS(SVG, 'title');
    captionTip.textContent = flowTooltip(flow, result);
    caption.appendChild(captionTip);
    caption.addEventListener('click', (event) => {
      event.stopPropagation();
      openFlowEditor(flow.id);
    });
    (overlay || svg).appendChild(caption);
  });
}

function flowTooltip(flow, result) {
  const lines = [
    `${flow.name || flow.tool || 'Backup'}: ${nodeName(flow.sourceNodeId)} → ${nodeName(flow.targetNodeId)}`,
    `State: ${Flows.stateLabel(Flows.stateOf(result))}`
  ];
  if (result && result.last) lines.push(`Last backup: ${new Date(result.last).toLocaleString()}`);
  if (result && result.detail) lines.push(result.detail);
  if (flow.schedule) lines.push(`Schedule: ${flow.schedule}`);
  lines.push('Click to edit');
  return lines.join('\n');
}

// ---------------------------------------------------------------- list

export function openFlowsModal() {
  document.getElementById('flows-show').checked = flowsVisible();
  refreshFlowList();
  openModal('flows-modal');
}

function refreshFlowList() {
  const list = document.getElementById('flows-list');
  if (!list) return;
  if (flows().length === 0) {
    list.innerHTML = `<div class="flows-empty">No backup flow yet. Add one here, or right-click the machine that is backed up.</div>`;
    return;
  }
  const now = Date.now();
  list.innerHTML = flows()
    .map((flow) => {
      const result = results.get(flow.id);
      const flowState = Flows.stateOf(result);
      const at = result && result.last ? Date.parse(result.last) : NaN;
      const when = Number.isNaN(at)
        ? flow.check && flow.check.type !== 'none'
          ? result
            ? ''
            : 'Not checked yet'
          : 'No check'
        : `Last backup ${Flows.ageText(now - at)}${Flows.ageText(now - at) === 'just now' ? '' : ' ago'}`;
      const meta = [flow.tool, flow.schedule].filter(Boolean).join(' · ');
      return `
        <div class="flow-row" data-flow-id="${escapeHtml(flow.id)}">
          <span class="flow-dot" style="background: ${COLORS[flowState]}" title="${Flows.stateLabel(flowState)}"></span>
          <div class="flow-row-main">
            <div class="flow-row-title">${escapeHtml(flow.name || flow.tool || 'Backup')}
              <span class="flow-row-route">${escapeHtml(nodeName(flow.sourceNodeId))} → ${escapeHtml(nodeName(flow.targetNodeId))}</span>
            </div>
            <div class="flow-row-meta">${escapeHtml([meta, when].filter(Boolean).join(' · '))}</div>
            ${result && result.detail ? `<div class="flow-row-detail flow-detail-${flowState}">${escapeHtml(result.detail)}</div>` : ''}
          </div>
          <span class="flow-state flow-state-${flowState}">${Flows.stateLabel(flowState)}</span>
          <button class="btn btn-secondary flow-row-edit" data-edit-flow="${escapeHtml(flow.id)}">Edit</button>
        </div>`;
    })
    .join('');
  list.querySelectorAll('[data-edit-flow]').forEach((button) => {
    button.addEventListener('click', () => openFlowEditor(button.dataset.editFlow));
  });
}

// ---------------------------------------------------------------- editor

function nodeOptions(selected) {
  return state.config.nodes
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(
      (node) =>
        `<option value="${escapeHtml(node.id)}" ${node.id === selected ? 'selected' : ''}>${escapeHtml(node.name || node.address || node.id)}</option>`
    )
    .join('');
}

function showCheckFields(type) {
  const ssh = type === 'folder' || type === 'command';
  document.getElementById('flow-check-ssh').classList.toggle('hidden', !ssh);
  document.getElementById('flow-check-folder').classList.toggle('hidden', type !== 'folder');
  document.getElementById('flow-check-command').classList.toggle('hidden', type !== 'command');
  document.getElementById('flow-check-http').classList.toggle('hidden', type !== 'http');
}

export function openFlowEditor(flowId, preset) {
  const existing = flowId ? flows().find((flow) => flow.id === flowId) : null;
  if (flowId && !existing) return;
  const nodes = state.config.nodes;
  if (nodes.length < 2) {
    toastError('Backup flow', 'A flow needs two nodes on the canvas.');
    return;
  }
  const sourceId = (preset && preset.sourceNodeId) || nodes[0].id;
  const fallbackTarget = (nodes.find((node) => node.id !== sourceId) || nodes[0]).id;
  const flow = existing
    ? JSON.parse(JSON.stringify(existing))
    : Flows.createFlow(sourceId, fallbackTarget);
  const check = flow.check || { type: 'none' };
  editingId = existing ? existing.id : null;
  loadedCommand = check.type === 'command' ? check.command || '' : '';

  document.getElementById('flow-edit-title').innerHTML =
    `<i data-lucide="database-backup" class="w-5 h-5 inline mr-2"></i>${existing ? 'Edit' : 'New'} Backup Flow`;
  document.getElementById('flow-name').value = flow.name || '';
  document.getElementById('flow-tool').value = flow.tool || '';
  document.getElementById('flow-source').innerHTML = nodeOptions(flow.sourceNodeId);
  document.getElementById('flow-target').innerHTML = nodeOptions(flow.targetNodeId);
  document.getElementById('flow-schedule').value = flow.schedule || '';
  document.getElementById('flow-max-age').value = flow.maxAgeHours || Flows.DEFAULT_MAX_AGE_HOURS;
  document.getElementById('flow-check-type').value = check.type || 'none';
  document.getElementById('flow-check-node').innerHTML = nodeOptions(
    check.nodeId || flow.targetNodeId
  );
  document.getElementById('flow-folder').value = check.type === 'folder' ? check.path || '' : '';
  document.getElementById('flow-depth').value = String(check.depth || 2);
  document.getElementById('flow-command').value = loadedCommand;
  document.getElementById('flow-url').value = check.type === 'http' ? check.url || '' : '';
  document.getElementById('flow-field').value = check.type === 'http' ? check.field || '' : '';
  document.getElementById('flow-delete').classList.toggle('hidden', !existing);
  showCheckFields(check.type || 'none');
  openModal('flow-edit-modal');
  document.getElementById('flow-name').focus();
}

function readEditor() {
  const type = document.getElementById('flow-check-type').value;
  const nodeId = document.getElementById('flow-check-node').value;
  let check = { type: 'none' };
  if (type === 'folder') {
    check = {
      type: 'folder',
      nodeId: nodeId,
      path: document.getElementById('flow-folder').value.trim(),
      depth: Number(document.getElementById('flow-depth').value) || 2
    };
  } else if (type === 'command') {
    check = {
      type: 'command',
      nodeId: nodeId,
      command: document.getElementById('flow-command').value.trim()
    };
  } else if (type === 'http') {
    check = {
      type: 'http',
      url: document.getElementById('flow-url').value.trim(),
      field: document.getElementById('flow-field').value.trim()
    };
  }
  const hours = Number(document.getElementById('flow-max-age').value);
  return {
    id: editingId || Flows.createFlow('', '').id,
    name: document.getElementById('flow-name').value.trim(),
    sourceNodeId: document.getElementById('flow-source').value,
    targetNodeId: document.getElementById('flow-target').value,
    tool: document.getElementById('flow-tool').value.trim(),
    schedule: document.getElementById('flow-schedule').value.trim(),
    maxAgeHours:
      Number.isFinite(hours) && hours >= 1 ? Math.round(hours) : Flows.DEFAULT_MAX_AGE_HOURS,
    check: check
  };
}

async function saveFlow() {
  const flow = readEditor();
  const error = Flows.editError(flow);
  if (error) {
    toastError('Backup flow', error);
    return;
  }
  const check = flow.check;
  if (check.type === 'command') {
    // A command loaded from a file and never approved here: ask before it
    // runs with the stored SSH login.
    const previous = editingId ? results.get(editingId) : null;
    const unapproved = previous && (previous.detail || '').startsWith(NOT_APPROVED);
    if (check.command === loadedCommand && unapproved) {
      const ok = await AppDialog.confirm(
        `Run this command on "${nodeName(check.nodeId)}" every 10 minutes while monitoring?\n\n${check.command}`
      );
      if (!ok) return;
    }
  }

  saveStateForUndo(
    editingId ? `Edit backup flow "${flow.name}"` : `Add backup flow "${flow.name}"`
  );
  const list = flows();
  const index = list.findIndex((item) => item.id === flow.id);
  if (index === -1) list.push(flow);
  else list[index] = flow;
  const saved = await saveConfig();
  if (saved && saved.success === false) {
    toastError('Backup flow not saved', saved.error || 'Save failed');
    return;
  }
  if (check.type === 'command' && window.desktopAPI && window.desktopAPI.flows) {
    const approved = await window.desktopAPI.flows.approve(check.nodeId, check.command);
    if (!approved || approved.success === false) {
      toastError('Command not approved', (approved && approved.error) || 'Approval failed');
    }
  }
  closeModal('flow-edit-modal');
  results.delete(flow.id);
  notified.delete(flow.id);
  toastSuccess('Backup flow saved', flow.name || flow.tool || 'Backup');
  refreshFlowList();
  requestAnimationFrame(drawLines);
  if (check.type !== 'none') checkFlows([flow.id]);
}

async function deleteFlow() {
  if (!editingId) return;
  const flow = flows().find((item) => item.id === editingId);
  if (!flow) return;
  const ok = await AppDialog.confirm(
    `Delete the backup flow "${flow.name || flow.tool || 'Backup'}"?`
  );
  if (!ok) return;
  saveStateForUndo(`Delete backup flow "${flow.name}"`);
  state.config.flows = flows().filter((item) => item.id !== editingId);
  results.delete(editingId);
  notified.delete(editingId);
  await saveConfig();
  closeModal('flow-edit-modal');
  refreshFlowList();
  requestAnimationFrame(drawLines);
}

export function bindFlowControls() {
  document.getElementById('btn-flows').addEventListener('click', openFlowsModal);
  onAction('add-flow', () => openFlowEditor(null));
  onAction('check-flows', () => {
    if (!hasChecks()) {
      toastError('Backup flows', 'No flow has a check yet.');
      return;
    }
    checkFlows();
  });
  onAction('save-flow', saveFlow);
  onAction('delete-flow', deleteFlow);
  document.getElementById('flow-check-type').addEventListener('change', (event) => {
    showCheckFields(event.target.value);
  });
  // The check runs on the destination unless another node is chosen.
  let lastTarget = null;
  const target = document.getElementById('flow-target');
  target.addEventListener('focus', () => {
    lastTarget = target.value;
  });
  target.addEventListener('change', () => {
    const runOn = document.getElementById('flow-check-node');
    if (!lastTarget || runOn.value === lastTarget) runOn.value = target.value;
    lastTarget = target.value;
  });
  document.getElementById('flows-show').addEventListener('change', async (event) => {
    state.config.settings = Object.assign({}, state.config.settings, {
      showFlows: event.target.checked
    });
    await saveConfig();
    requestAnimationFrame(drawLines);
  });
}
