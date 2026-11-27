// The canvas grid: a pattern of TopologyCanvas.GRID_STEP world pixels, painted
// in the viewport behind the world, with the column letters and row numbers of
// the cells on screen. The pattern repeats without an edge, so panning never
// runs out of grid; the labels of a cell show the same name the node prints.

import { TopologyCanvas } from './libs.js';
import { state } from './state.js';

const MIN_LABEL_GAP = 64; // screen pixels between two labels
const MAX_LABELS = 200;

export function updateGrid() {
  const viewport = document.getElementById('viewport');
  const layer = document.getElementById('grid-layer');
  if (!viewport || !layer) return;

  const step = TopologyCanvas.GRID_STEP * state.scale;
  layer.style.backgroundSize = step + 'px ' + step + 'px';
  layer.style.backgroundPosition = state.pointX + 'px ' + state.pointY + 'px';

  const labels = document.getElementById('grid-labels');
  if (!labels) return;
  labels.innerHTML = '';

  // A cell a few pixels wide carries no readable label: keep the lines.
  if (step < 6) return;

  // Thinner cells get a label every 2, 4, ... cells so they stay apart.
  let every = 1;
  while (step * every < MIN_LABEL_GAP) every *= 2;

  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const addLabel = (text, style) => {
    const el = document.createElement('div');
    el.className = 'grid-label';
    el.textContent = text;
    Object.assign(el.style, style);
    labels.appendChild(el);
  };

  const firstCol = Math.floor(-state.pointX / step);
  const lastCol = Math.ceil((width - state.pointX) / step);
  const firstRow = Math.floor(-state.pointY / step);
  const lastRow = Math.ceil((height - state.pointY) / step);
  let count = 0;

  for (
    let col = Math.ceil(firstCol / every) * every;
    col <= lastCol && count < MAX_LABELS;
    col += every
  ) {
    addLabel(TopologyCanvas.columnLabel(col), {
      left: state.pointX + col * step + 'px',
      top: '0',
      width: step * every - 1 + 'px',
      height: '16px'
    });
    count += 1;
  }
  for (
    let row = Math.ceil(firstRow / every) * every;
    row <= lastRow && count < MAX_LABELS;
    row += every
  ) {
    addLabel(String(row + 1), {
      left: '0',
      top: state.pointY + row * step + 'px',
      width: '20px',
      height: step * every - 1 + 'px'
    });
    count += 1;
  }
}
