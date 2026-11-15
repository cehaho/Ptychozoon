// Backup flows: a logical overlay from the machine that is backed up to the
// one that stores the copy. Not cables: they play no part in the parent /
// failover logic.
//
// Keep normalizeFlows aligned with src-tauri/src/flows.rs. The checks run in
// the backend (flows_check); this file holds the model, the captions, the
// notifications and the arrow geometry.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.Flows = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NAME_LIMIT = 80;
  const LABEL_LIMIT = 40;
  const PATH_LIMIT = 512;
  const COMMAND_LIMIT = 1000;
  const URL_LIMIT = 2048;
  const FIELD_LIMIT = 120;
  const DEFAULT_MAX_AGE_HOURS = 26;
  const MAX_AGE_HOURS = 24 * 366;
  const DEFAULT_DEPTH = 2;
  const CHECK_TYPES = ['none', 'folder', 'command', 'http'];
  const STATES = ['ok', 'late', 'failed', 'unknown'];
  // Control characters (Unicode Cc), as Rust's char::is_control.
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
  // eslint-disable-next-line no-control-regex
  const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
  // The same, but a command keeps its tabs and newlines.
  // eslint-disable-next-line no-control-regex
  const CONTROL_KEEP_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value, limit) {
    if (typeof value !== 'string') return null;
    const trimmed = value.replace(CONTROL, '').trim();
    if (!trimmed) return null;
    return Array.from(trimmed).slice(0, limit).join('');
  }

  function rawText(value, limit) {
    if (typeof value !== 'string') return null;
    const trimmed = value.replace(CONTROL_KEEP_LINES, '').trim();
    if (!trimmed || Array.from(trimmed).length > limit) return null;
    return trimmed;
  }

  function normalizeCheck(raw, target, nodeIds) {
    if (!isObject(raw)) return { type: 'none' };
    const wanted = text(raw.nodeId, 128);
    const nodeId = wanted && nodeIds.has(wanted) ? wanted : target;
    if (raw.type === 'folder') {
      const depth =
        Number.isInteger(raw.depth) && raw.depth >= 0
          ? Math.min(5, Math.max(1, raw.depth))
          : DEFAULT_DEPTH;
      return {
        type: 'folder',
        nodeId: nodeId,
        path: text(raw.path, PATH_LIMIT) || '',
        depth: depth
      };
    }
    if (raw.type === 'command') {
      return {
        type: 'command',
        nodeId: nodeId,
        command: rawText(raw.command, COMMAND_LIMIT) || ''
      };
    }
    if (raw.type === 'http') {
      return {
        type: 'http',
        url: text(raw.url, URL_LIMIT) || '',
        field: text(raw.field, FIELD_LIMIT) || ''
      };
    }
    return { type: 'none' };
  }

  function normalizeFlow(raw, index, nodeIds) {
    if (!isObject(raw)) return null;
    const source = text(raw.sourceNodeId, 128);
    const target = text(raw.targetNodeId, 128);
    if (!source || !target || source === target) return null;
    if (!nodeIds.has(source) || !nodeIds.has(target)) return null;
    const hours = raw.maxAgeHours;
    const maxAgeHours =
      typeof hours === 'number' && Number.isFinite(hours) && hours >= 1
        ? Math.min(MAX_AGE_HOURS, Math.round(hours))
        : DEFAULT_MAX_AGE_HOURS;
    return {
      id: text(raw.id, 128) || 'flow_migrated_' + index,
      name: text(raw.name, NAME_LIMIT) || '',
      sourceNodeId: source,
      targetNodeId: target,
      tool: text(raw.tool, LABEL_LIMIT) || '',
      schedule: text(raw.schedule, LABEL_LIMIT) || '',
      maxAgeHours: maxAgeHours,
      check: normalizeCheck(raw.check, target, nodeIds)
    };
  }

  // The flows of a document, cleaned: flows whose ends are not nodes are
  // dropped, unknown fields are dropped, values are clamped.
  function normalizeFlows(raw, nodeIds) {
    if (!Array.isArray(raw)) return [];
    const ids = nodeIds instanceof Set ? nodeIds : new Set(nodeIds || []);
    const flows = [];
    const seen = new Set();
    raw.forEach((item, index) => {
      const flow = normalizeFlow(item, index, ids);
      if (!flow || seen.has(flow.id)) return;
      seen.add(flow.id);
      flows.push(flow);
    });
    return flows;
  }

  function flowsError(raw) {
    if (raw === undefined || raw === null) return '';
    if (!Array.isArray(raw) || !raw.every(isObject)) {
      return 'Configuration flows must be an array of objects';
    }
    return '';
  }

  function isSafeFolder(path) {
    return (
      typeof path === 'string' &&
      path.startsWith('/') &&
      path.length <= PATH_LIMIT &&
      path.indexOf("'") === -1 &&
      !HAS_CONTROL.test(path)
    );
  }

  function createFlow(sourceNodeId, targetNodeId) {
    return {
      id: 'flow_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: '',
      sourceNodeId: sourceNodeId,
      targetNodeId: targetNodeId,
      tool: '',
      schedule: '',
      maxAgeHours: DEFAULT_MAX_AGE_HOURS,
      check: { type: 'none' }
    };
  }

  // Why a flow cannot be saved, or '' when it can.
  function editError(flow) {
    if (!flow.sourceNodeId || !flow.targetNodeId) return 'Choose the source and the destination.';
    if (flow.sourceNodeId === flow.targetNodeId) {
      return 'The source and the destination must be different nodes.';
    }
    const check = flow.check || {};
    if (check.type === 'folder' && !isSafeFolder(check.path)) {
      return 'The folder must be an absolute path (starting with /) without quotes.';
    }
    if (check.type === 'command' && !rawText(check.command, COMMAND_LIMIT)) {
      return 'Enter the command that prints the date of the last good backup.';
    }
    if (check.type === 'http' && !/^https?:\/\/\S+$/i.test(check.url || '')) {
      return 'The URL must start with http:// or https://.';
    }
    return '';
  }

  // "just now", "12 min", "5 h", "3 d".
  function ageText(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    const minutes = Math.floor(Math.max(0, ms) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + ' h';
    return Math.floor(hours / 24) + ' d';
  }

  function stateLabel(state) {
    if (state === 'ok') return 'OK';
    if (state === 'late') return 'Late';
    if (state === 'failed') return 'Failed';
    return 'Unknown';
  }

  function stateOf(result) {
    return result && STATES.indexOf(result.state) !== -1 ? result.state : 'unknown';
  }

  // Short text drawn on the arrow: name, then the age of the last backup.
  function caption(flow, result, now) {
    const title = flow.name || flow.tool || 'Backup';
    const state = stateOf(result);
    if (state === 'failed') return title + ' · failed';
    const at = result && result.last ? Date.parse(result.last) : NaN;
    if (!Number.isNaN(at)) {
      const age = ageText(now - at);
      return title + ' · ' + (age === 'just now' ? age : age + ' ago');
    }
    return title;
  }

  // Notifications for flows that just became late or failed. `previous`
  // maps flow id -> last state; it is updated in place.
  function transitions(previous, results, flows) {
    const names = new Map((flows || []).map((flow) => [flow.id, flow]));
    const notes = [];
    (results || []).forEach((result) => {
      const flow = names.get(result.id);
      const state = stateOf(result);
      const before = previous.get(result.id);
      previous.set(result.id, state);
      if (!flow || state === before) return;
      if (state !== 'late' && state !== 'failed') return;
      const title = flow.name || flow.tool || 'Backup flow';
      notes.push({
        title: state === 'failed' ? 'Backup failed' : 'Backup late',
        body:
          state === 'failed'
            ? '"' + title + '": ' + (result.detail || 'the last backup failed')
            : '"' + title + '": no good backup for more than ' + flow.maxAgeHours + ' h'
      });
    });
    return notes;
  }

  // Point where the segment from the centre of `box` towards (tx, ty) leaves
  // the box. Boxes are { x, y, width, height } with (x, y) the centre.
  function boxExit(box, tx, ty) {
    const dx = tx - box.x;
    const dy = ty - box.y;
    if (dx === 0 && dy === 0) return { x: box.x, y: box.y };
    const sx = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
    const sy = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
    const scale = Math.min(sx, sy);
    return { x: box.x + dx * scale, y: box.y + dy * scale };
  }

  // Curved arrow between two node boxes, bent to one side so it does not lie
  // on a straight cable. `lane` spreads several flows between the same pair.
  function arrowPath(fromBox, toBox, lane) {
    const start = boxExit(fromBox, toBox.x, toBox.y);
    const end = boxExit(toBox, fromBox.x, fromBox.y);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const bend = Math.min(80, 30 + length * 0.12) * (1 + 0.6 * (lane || 0));
    const nx = -dy / length;
    const ny = dx / length;
    const cx = (start.x + end.x) / 2 + nx * bend;
    const cy = (start.y + end.y) / 2 + ny * bend;
    const round = (value) => Math.round(value * 10) / 10;
    return {
      d: `M ${round(start.x)} ${round(start.y)} Q ${round(cx)} ${round(cy)} ${round(end.x)} ${round(end.y)}`,
      // Middle of the curve (t = 0.5), for the caption.
      labelX: round((start.x + 2 * cx + end.x) / 4),
      labelY: round((start.y + 2 * cy + end.y) / 4)
    };
  }

  return {
    CHECK_TYPES: CHECK_TYPES,
    DEFAULT_MAX_AGE_HOURS: DEFAULT_MAX_AGE_HOURS,
    normalizeFlows: normalizeFlows,
    flowsError: flowsError,
    isSafeFolder: isSafeFolder,
    createFlow: createFlow,
    editError: editError,
    ageText: ageText,
    stateLabel: stateLabel,
    stateOf: stateOf,
    caption: caption,
    transitions: transitions,
    boxExit: boxExit,
    arrowPath: arrowPath
  };
});
