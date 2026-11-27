// Canvas geometry: grid snap, zoom and pan, port anchors, link paths,
// rectangle selection, auto-layout and the minimap.
//
// Pure functions only; the app/ modules own the DOM and the view state
// ({ scale, pointX, pointY }) and passes measurements in. Node positions are
// absolute world pixels (x to the right, y downwards) with no bounds, so the
// canvas pans without limit; the grid is a pattern of GRID_STEP px cells
// anchored at the origin.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.TopologyCanvas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GRID_STEP = 40; // world pixels; the grid has no outer edge
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 5;
  const ZOOM_STEP = 1.1;
  const MINIMAP_WIDTH = 200;
  const MINIMAP_HEIGHT = 150;
  const MINIMAP_PADDING = 200;
  const LAYOUT_COLUMN = 200;
  const LAYOUT_ROW = 180;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Spreadsheet-like column name: A, B, ..., Z, AA, AB, ... Negative
  // columns (left of the origin) are prefixed with a dash: -A, -B, ...
  function columnLabel(index) {
    const negative = index < 0;
    let n = negative ? -index - 1 : index;
    let text = '';
    do {
      text = String.fromCharCode(65 + (n % 26)) + text;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return (negative ? '-' : '') + text;
  }

  // Snap to the centre of the GRID_STEP cell that holds the point. Off: the
  // position is left alone. There is no edge to clamp to.
  function snapToGrid(x, y, enabled) {
    if (!enabled) return { x: x, y: y };
    const offset = GRID_STEP / 2;
    return {
      x: Math.round((x - offset) / GRID_STEP) * GRID_STEP + offset,
      y: Math.round((y - offset) / GRID_STEP) * GRID_STEP + offset
    };
  }

  // Cell of a world point: column letter and row number, both unbounded.
  function gridCell(x, y) {
    return {
      col: columnLabel(Math.floor(x / GRID_STEP)),
      row: Math.floor(y / GRID_STEP) + 1
    };
  }

  // Zoom one step around the cursor: the world point under it stays put.
  function zoomAt(view, clientX, clientY, deltaY) {
    const xs = (clientX - view.pointX) / view.scale;
    const ys = (clientY - view.pointY) / view.scale;
    const grown = -deltaY > 0 ? view.scale * ZOOM_STEP : view.scale / ZOOM_STEP;
    const scale = clamp(grown, MIN_SCALE, MAX_SCALE);
    return { scale: scale, pointX: clientX - xs * scale, pointY: clientY - ys * scale };
  }

  function screenToWorld(view, clientX, clientY, originLeft, originTop) {
    return {
      x: (clientX - (originLeft || 0) - view.pointX) / view.scale,
      y: (clientY - (originTop || 0) - view.pointY) / view.scale
    };
  }

  // Pan offset that puts a world point in the middle of the viewport.
  function centerOn(worldX, worldY, viewportWidth, viewportHeight, scale) {
    return {
      pointX: viewportWidth / 2 - worldX * scale,
      pointY: viewportHeight / 2 - worldY * scale
    };
  }

  function normalizeRect(ax, ay, bx, by) {
    return {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay)
    };
  }

  function nodeInRect(node, rect) {
    const x = Number(node && node.x);
    const y = Number(node && node.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }

  function nodesInRect(nodes, rect) {
    return (nodes || []).filter((node) => nodeInRect(node, rect)).map((node) => node.id);
  }

  // Where a port sits along its side, in percent. Matches the CSS spread.
  function portOffsetPercent(ports, port) {
    const side = port ? port.side : undefined;
    const id = port ? port.id : undefined;
    const sameSide = (ports || []).filter((p) => p.side === side);
    const count = sameSide.length;
    if (count <= 1) return 50;
    const index = sameSide.findIndex((p) => p.id === id);
    const positions =
      count === 2
        ? [35, 65]
        : count === 3
          ? [30, 50, 70]
          : Array.from({ length: count }, (_, i) => 20 + (60 * i) / (count - 1));
    return positions[index] || 50;
  }

  // Anchor of a port on a node box whose (x, y) is the centre.
  function portAnchor(box, ports, port) {
    const offset = portOffsetPercent(ports, port);
    const left = box.x - box.width / 2;
    const top = box.y - box.height / 2;
    switch ((port && port.side) || 'bottom') {
      case 'top':
        return { x: left + (box.width * offset) / 100, y: top };
      case 'bottom':
        return { x: left + (box.width * offset) / 100, y: box.y + box.height / 2 };
      case 'left':
        return { x: left, y: top + (box.height * offset) / 100 };
      case 'right':
        return { x: box.x + box.width / 2, y: top + (box.height * offset) / 100 };
      default:
        return { x: box.x, y: box.y };
    }
  }

  function controlPoint(x, y, side, curvature) {
    switch (side) {
      case 'top':
        return { x: x, y: y - curvature };
      case 'bottom':
        return { x: x, y: y + curvature };
      case 'left':
        return { x: x - curvature, y: y };
      case 'right':
        return { x: x + curvature, y: y };
      default:
        return { x: x, y: y };
    }
  }

  const SIDES = ['top', 'right', 'bottom', 'left'];

  // Sides of a node that have no port yet. The canvas offers a handle on
  // each of them, so a link can be drawn from or to any side.
  function freeSides(ports) {
    const used = new Set((ports || []).map((p) => p.side));
    return SIDES.filter((side) => !used.has(side));
  }

  // New port for a side handle: named after the side, made unique.
  function sidePort(nodeId, ports, side) {
    const list = ports || [];
    const base = side.toUpperCase();
    const names = new Set(list.map((p) => p.name));
    const ids = new Set(list.map((p) => p.id));
    let n = 1;
    let name = base;
    while (names.has(name)) name = `${base} ${++n}`;
    let id = `${nodeId}_${side}`;
    for (let i = 2; ids.has(id); i++) id = `${nodeId}_${side}${i}`;
    return { id: id, name: name, side: side };
  }

  // Cubic curve leaving each port along its side's normal.
  function bezierPath(x1, y1, x2, y2, sourceSide, targetSide) {
    const distance = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    const curvature = Math.min(distance * 0.5, 100);
    const c1 = controlPoint(x1, y1, sourceSide, curvature);
    const c2 = controlPoint(x2, y2, targetSide, curvature);
    return `M ${x1} ${y1} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${x2} ${y2}`;
  }

  function linkLabel(link) {
    return [link && link.medium, link && link.speed].filter(Boolean).join(' ');
  }

  // Background box and text anchor for a label at the middle of a link.
  function labelBox(x1, y1, x2, y2, text) {
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const width = String(text).length * 6 + 8;
    return {
      x: midX - width / 2,
      y: midY - 8,
      width: width,
      height: 16,
      textX: midX,
      textY: midY + 4
    };
  }

  // Stroke of the base path for a Probe.linkLook result.
  function linkStroke(look) {
    return {
      color: look.color,
      opacity: look.waiting ? '0.28' : '0.45',
      dash: look.waiting ? '2 7' : null,
      animated: Boolean(look.animate)
    };
  }

  // Breadth-first levels from the roots (no incoming link), one row per level.
  // Returns new positions; the caller writes them to the nodes.
  function autoLayout(nodes, links) {
    const list = nodes || [];
    const connections = links || [];
    const adjacency = new Map();
    list.forEach((node) => adjacency.set(node.id, new Set()));
    connections.forEach((conn) => {
      if (adjacency.has(conn.sourceNodeId) && adjacency.has(conn.targetNodeId)) {
        adjacency.get(conn.sourceNodeId).add(conn.targetNodeId);
        adjacency.get(conn.targetNodeId).add(conn.sourceNodeId);
      }
    });

    let roots = list.filter((node) => !connections.some((c) => c.targetNodeId === node.id));
    if (roots.length === 0 && list.length) {
      roots = [
        list.reduce((best, node) => {
          const conns = adjacency.get(node.id).size;
          const bestConns = adjacency.get(best.id).size;
          return conns > bestConns ? node : best;
        }, list[0])
      ];
    }

    const levels = new Map();
    const visited = new Set();
    const queue = roots.map((n) => ({ id: n.id, level: 0 }));
    while (queue.length > 0) {
      const item = queue.shift();
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      levels.set(item.id, item.level);
      adjacency.get(item.id).forEach((neighborId) => {
        if (!visited.has(neighborId)) queue.push({ id: neighborId, level: item.level + 1 });
      });
    }
    list.forEach((node) => {
      if (!levels.has(node.id)) levels.set(node.id, 0);
    });

    const byLevel = new Map();
    levels.forEach((level, id) => {
      if (!byLevel.has(level)) byLevel.set(level, []);
      byLevel.get(level).push(id);
    });

    // Rows are centred on the origin, so the layout does not depend on the
    // window size and fits whatever part of the canvas is on screen.
    const positions = new Map();
    const levelCount = byLevel.size;
    byLevel.forEach((ids, level) => {
      const startX = (-(ids.length - 1) * LAYOUT_COLUMN) / 2;
      const y = (level - (levelCount - 1) / 2) * LAYOUT_ROW;
      ids.forEach((id, idx) => {
        positions.set(id, { x: startX + idx * LAYOUT_COLUMN, y: y });
      });
    });
    return { positions: positions, levelCount: levelCount };
  }

  function minimapNodeColor(selected, state) {
    if (selected) return '#4d9fea';
    if (state === 'up') return '#5fb85a';
    if (state === 'down') return '#e5674f';
    return '#8a8a8a';
  }

  // Bounds shown by the minimap: the nodes plus the visible viewport, with
  // some room around them. There is no fixed world size to fall back on.
  function contentBounds(view, viewportWidth, viewportHeight, nodes, padding) {
    const scale = (view && view.scale) || 1;
    const pad = padding === undefined || padding === null ? MINIMAP_PADDING : padding;
    let minX = -((view && view.pointX) || 0) / scale;
    let minY = -((view && view.pointY) || 0) / scale;
    let maxX = minX + viewportWidth / scale;
    let maxY = minY + viewportHeight / scale;
    (nodes || []).forEach((node) => {
      const x = Number(node && node.x);
      const y = Number(node && node.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });
    return {
      x: minX - pad,
      y: minY - pad,
      width: Math.max(maxX - minX + 2 * pad, 1),
      height: Math.max(maxY - minY + 2 * pad, 1)
    };
  }

  // Minimap point for a node position, inside `bounds`.
  function minimapPoint(node, bounds, width, height) {
    const box = bounds || { x: 0, y: 0, width: 1, height: 1 };
    return {
      x: ((Number(node.x) - box.x) / box.width) * width,
      y: ((Number(node.y) - box.y) / box.height) * height
    };
  }

  // Draw links first, then nodes on top, onto a 2D context.
  // options: { width, height, dark, nodes, links, lookFor(link), colorFor(node) }
  function drawMinimap(ctx, options) {
    const width = options.width || MINIMAP_WIDTH;
    const height = options.height || MINIMAP_HEIGHT;
    const nodes = options.nodes || [];
    const bounds = options.bounds || contentBounds(null, 0, 0, nodes);
    const byId = new Map();
    nodes.forEach((n) => {
      if (!byId.has(n.id)) byId.set(n.id, n);
    });

    ctx.fillStyle = options.dark ? '#212121' : '#f5f4f2';
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 1;

    (options.links || []).forEach((link) => {
      const source = byId.get(link.sourceNodeId);
      const target = byId.get(link.targetNodeId);
      if (!source || !target) return;
      const a = minimapPoint(source, bounds, width, height);
      const b = minimapPoint(target, bounds, width, height);
      const look = options.lookFor(link);
      ctx.beginPath();
      ctx.strokeStyle = look.color;
      ctx.globalAlpha = look.waiting ? 0.35 : 0.75;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    nodes.forEach((node) => {
      const p = minimapPoint(node, bounds, width, height);
      ctx.fillStyle = options.colorFor(node);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // The visible part of the world, in minimap pixels, clipped to the minimap.
  function minimapIndicator(view, viewportWidth, viewportHeight, bounds, width, height) {
    const w = width || MINIMAP_WIDTH;
    const h = height || MINIMAP_HEIGHT;
    const box = bounds || { x: 0, y: 0, width: 1, height: 1 };
    const sx = w / box.width;
    const sy = h / box.height;
    const x = (-view.pointX / view.scale - box.x) * sx;
    const y = (-view.pointY / view.scale - box.y) * sy;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    return {
      left: left,
      top: top,
      width: Math.max(0, Math.min(w, x + (viewportWidth / view.scale) * sx) - left),
      height: Math.max(0, Math.min(h, y + (viewportHeight / view.scale) * sy) - top)
    };
  }

  // A click on the minimap, as the world point it stands for.
  function minimapToWorld(clickX, clickY, bounds, width, height) {
    const box = bounds || { x: 0, y: 0, width: 1, height: 1 };
    return {
      x: box.x + (clickX / width) * box.width,
      y: box.y + (clickY / height) * box.height
    };
  }

  return {
    GRID_STEP: GRID_STEP,
    MIN_SCALE: MIN_SCALE,
    MAX_SCALE: MAX_SCALE,
    MINIMAP_WIDTH: MINIMAP_WIDTH,
    MINIMAP_HEIGHT: MINIMAP_HEIGHT,
    columnLabel: columnLabel,
    snapToGrid: snapToGrid,
    gridCell: gridCell,
    zoomAt: zoomAt,
    screenToWorld: screenToWorld,
    centerOn: centerOn,
    normalizeRect: normalizeRect,
    nodeInRect: nodeInRect,
    nodesInRect: nodesInRect,
    portOffsetPercent: portOffsetPercent,
    portAnchor: portAnchor,
    freeSides: freeSides,
    sidePort: sidePort,
    bezierPath: bezierPath,
    linkLabel: linkLabel,
    labelBox: labelBox,
    linkStroke: linkStroke,
    autoLayout: autoLayout,
    minimapNodeColor: minimapNodeColor,
    contentBounds: contentBounds,
    minimapPoint: minimapPoint,
    drawMinimap: drawMinimap,
    minimapIndicator: minimapIndicator,
    minimapToWorld: minimapToWorld
  };
});
