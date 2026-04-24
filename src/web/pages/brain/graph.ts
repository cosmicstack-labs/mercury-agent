import { Context } from 'hono';
import { renderLayout } from '../layout.js';

export function renderGraph(c: Context): string {
  const body = `
<div class="page" x-data="brainGraph()" x-init="init()" @keydown.escape="selectedNode = null">
  <div class="page-header">
    <h1>Brain Graph</h1>
    <p class="page-subtitle">Visualize connections between your memories</p>
  </div>

  <div class="graph-controls">
    <div class="graph-controls-left">
      <template x-for="(color, type) in typeColors" :key="type">
        <label class="filter-chip" :class="{ 'filter-active': activeTypes.includes(type) }">
          <input type="checkbox" :value="type" x-model="activeTypes" @change="rebuildGraph()"
                 class="filter-check">
          <span class="filter-dot" :style="'background:' + color"></span>
          <span x-text="type.charAt(0).toUpperCase() + type.slice(1)"></span>
        </label>
      </template>
    </div>
    <div class="graph-controls-right">
      <input type="text" class="form-input form-input-sm" placeholder="Search nodes..."
             x-model="searchQuery" @input="highlightSearch()" style="max-width: 200px;">
      <button class="btn btn-sm btn-outline" @click="runLayout()" :disabled="layoutRunning">
        <span x-text="layoutRunning ? 'Laying out...' : 'Re-layout'"></span>
      </button>
    </div>
  </div>

  <div class="graph-container" x-ref="graphContainer"
       @mousedown="onMouseDown($event)"
       @mousemove="onMouseMove($event)"
       @mouseup="onMouseUp($event)"
       @wheel.prevent="onWheel($event)"
       @dblclick="onDblClick($event)">
    <canvas x-ref="graphCanvas"></canvas>
    <div class="graph-empty" x-show="nodes.length === 0 && !loading">
      No memories to display. Start a conversation to build your second brain.
    </div>
    <div class="graph-loading" x-show="loading">Loading graph...</div>
  </div>

  <div class="graph-tooltip" x-show="hoveredNode" x-transition
       :style="tooltipStyle" x-text="hoveredNode?.label"></div>

  <div class="node-detail" x-show="selectedNode" x-transition>
    <template x-if="selectedNode">
      <div>
        <div class="node-detail-header">
          <span class="memory-type" :style="'background:' + getTypeColor(selectedNode?.type)" x-text="selectedNode?.type"></span>
          <button class="btn btn-sm" @click="selectedNode = null">&times;</button>
        </div>
        <div class="node-detail-summary" x-text="selectedNode?.fullLabel || selectedNode?.label"></div>
        <div class="node-detail-meta" x-show="selectedNode">
          <span>Importance: <strong x-text="(selectedNode?.importance * 100).toFixed(0) + '%'"></strong></span>
          <span>Confidence: <strong x-text="(selectedNode?.confidence * 100).toFixed(0) + '%'"></strong></span>
        </div>
      </div>
    </template>
  </div>
</div>`;

  return renderLayout(c, 'Brain Graph', body);
}