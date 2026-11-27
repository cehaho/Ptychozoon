// Proxmox guests: ask the API of a Proxmox VE host (port 8006) for its virtual
// machines and containers, then add the selected ones under a Proxmox
// container node on the canvas.
//
// The API token is used for this request only: it is not written to the
// topology file nor to the keyring.

import { Topology } from './libs.js';
import { escapeHtml } from './util.js';
import { state } from './state.js';
import { closeModal, onAction, openModal, toastError, toastInfo, toastSuccess } from './ui.js';
import { saveConfig } from './io.js';
import { viewportCenter } from './viewport.js';
import { renderTree } from './canvas-render.js';
import { refreshHostList } from './host-list.js';

let guests = []; // { node, vmid, name, type, status, selected }
let targetHost = '';

export function openProxmoxModal() {
  if (!window.desktopAPI || !window.desktopAPI.proxmox) {
    toastInfo(
      'Proxmox unavailable',
      'Proxmox discovery is only available in the desktop application'
    );
    return;
  }
  guests = [];
  targetHost = '';
  document.getElementById('pve-results').innerHTML = '';
  document.getElementById('pve-results').classList.add('hidden');
  document.getElementById('btn-add-guests').classList.add('hidden');
  document.getElementById('pve-token-secret').value = '';
  document.getElementById('pve-status').textContent = '';
  openModal('proxmox-modal');
}

async function discoverGuests() {
  const address = document.getElementById('pve-address').value.trim();
  const portText = document.getElementById('pve-port').value.trim();
  const tokenId = document.getElementById('pve-token-id').value.trim();
  const tokenSecret = document.getElementById('pve-token-secret').value;
  const insecureTls = document.getElementById('pve-insecure').checked;
  if (!address) {
    toastError('Missing host', 'Enter the address of a Proxmox VE host');
    return;
  }
  if (!tokenId || !tokenSecret) {
    toastError('Missing token', 'Enter the API token id and its secret');
    return;
  }
  const port = portText ? Number(portText) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    toastError('Invalid port', 'The API port must be between 1 and 65535');
    return;
  }

  const status = document.getElementById('pve-status');
  status.textContent = 'Asking the Proxmox API...';
  document.getElementById('pve-results').classList.add('hidden');
  document.getElementById('btn-add-guests').classList.add('hidden');

  let result;
  try {
    result = await window.desktopAPI.proxmox.discover({
      address,
      port,
      tokenId,
      tokenSecret,
      insecureTls
    });
  } catch (error) {
    result = { success: false, error: error && error.message ? error.message : 'Unknown error' };
  }
  if (!result || result.success !== true) {
    status.textContent = '';
    toastError('Proxmox discovery failed', (result && result.error) || 'Unknown error');
    return;
  }

  targetHost = address;
  guests = [];
  (result.nodes || []).forEach((node) => {
    (node.guests || []).forEach((guest) => {
      guests.push(Object.assign({ node: node.name, selected: guest.status === 'running' }, guest));
    });
  });
  const version = result.version ? `Proxmox VE ${result.version}` : 'Proxmox VE';
  status.textContent = `${version}: ${guests.length} guest${guests.length === 1 ? '' : 's'}`;
  renderGuests();
  document.getElementById('pve-results').classList.remove('hidden');
  document.getElementById('btn-add-guests').classList.toggle('hidden', guests.length === 0);
}

function renderGuests() {
  const container = document.getElementById('pve-results');
  container.innerHTML = '';
  if (guests.length === 0) return;
  const table = document.createElement('table');
  table.className = 'discovery-table';
  table.innerHTML =
    '<thead><tr><th></th><th>VMID</th><th>Name</th><th>Kind</th><th>Node</th><th>Status</th></tr></thead>';
  const body = document.createElement('tbody');
  guests.forEach((guest, index) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><input type="checkbox" class="pve-select" ${guest.selected ? 'checked' : ''}></td>
      <td class="font-mono">${escapeHtml(String(guest.vmid))}</td>
      <td>${escapeHtml(guest.name)}</td>
      <td class="text-slate-400">${guest.type === 'lxc' ? 'Container' : 'VM'}</td>
      <td class="text-slate-400">${escapeHtml(guest.node)}</td>
      <td class="text-slate-400">${escapeHtml(guest.status || '')}</td>
    `;
    row.querySelector('.pve-select').addEventListener('change', (event) => {
      guests[index].selected = event.target.checked;
    });
    body.appendChild(row);
  });
  table.appendChild(body);
  container.appendChild(table);
}

// The container node that holds the guests of this Proxmox host, created on
// its first import.
function ensureContainer(host) {
  const existing = state.config.nodes.find(
    (node) =>
      node.isContainer && node.containerType === 'proxmox' && String(node.address || '') === host
  );
  if (existing) return existing;
  const center = viewportCenter() || {};
  const container = Topology.createNode({
    id: 'node_' + Date.now() + '_pve',
    name: host,
    address: host,
    icon: 'server',
    isContainer: true,
    containerType: 'proxmox',
    expanded: true,
    x: Number.isFinite(center.x) ? Math.round(center.x) : 0,
    y: Number.isFinite(center.y) ? Math.round(center.y) : 0
  });
  state.config.nodes.push(container);
  return container;
}

async function addGuests() {
  const selected = guests.filter((guest) => guest.selected);
  if (selected.length === 0) {
    toastInfo('Nothing selected', 'Tick the guests you want to add to the canvas');
    return;
  }
  const container = ensureContainer(targetHost);
  const stamp = Date.now();
  selected.forEach((guest, index) => {
    const node = Topology.createNode({
      id: 'node_' + stamp + '_' + index,
      name: guest.name,
      // The API does not report the guest address: it is set later in the
      // node form, and until then the node is not monitored.
      address: '',
      icon: 'server',
      containerId: container.id
    });
    state.config.nodes.push(node);
  });
  const saved = await saveConfig();
  if (saved && saved.success === false) {
    toastError('Save failed', saved.error || 'The topology could not be saved');
    return;
  }
  toastSuccess(
    'Guests added',
    `${selected.length} guest${selected.length === 1 ? '' : 's'} added under ${container.name}`
  );
  closeModal('proxmox-modal');
  renderTree(state.config.nodes);
  refreshHostList();
}

export function bindProxmoxControls() {
  onAction('open-proxmox', openProxmoxModal);
  onAction('discover-proxmox', discoverGuests);
  onAction('add-guests', addGuests);
}
