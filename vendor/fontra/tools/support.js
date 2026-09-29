// Shim for Fontra editor-internal modules that the tools import:
// panel-transformation.js, scene-controller.js, visualization-layer-definitions.js.
// Provides the exact exports the vendored tools need, backed by our own registry.

const visualizationLayerDefinitions = [];

export function registerVisualizationLayerDefinition(definition) {
  visualizationLayerDefinitions.push(definition);
}

export function getVisualizationLayerDefinitions() {
  return visualizationLayerDefinitions;
}

export function glyphSelector(which) {
  return (visContext) => visContext.glyphsBySelectionMode[which] || [];
}

export function equalGlyphSelection(a, b) {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.lineIndex === b.lineIndex && a.glyphIndex === b.glyphIndex;
}

export function getPinPoint(bounds, originX, originY) {
  let pinX = (bounds.xMin + bounds.xMax) / 2;
  let pinY = (bounds.yMin + bounds.yMax) / 2;
  if (typeof originX === "number") {
    pinX = originX;
  } else if (originX === "left") {
    pinX = bounds.xMin;
  } else if (originX === "right") {
    pinX = bounds.xMax;
  }
  if (typeof originY === "number") {
    pinY = originY;
  } else if (originY === "top") {
    pinY = bounds.yMax;
  } else if (originY === "bottom") {
    pinY = bounds.yMin;
  }
  return { x: pinX, y: pinY };
}

export function strokeLine(context, x1, y1, x2, y2) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function nodePath(context, position, size, square) {
  context.beginPath();
  if (square) {
    context.rect(position.x - size / 2, position.y - size / 2, size, size);
  } else {
    context.arc(position.x, position.y, size / 2, 0, 2 * Math.PI);
  }
}

export function fillRoundNode(context, position, size) {
  nodePath(context, position, size, false);
  context.fill();
}

export function strokeRoundNode(context, position, size) {
  nodePath(context, position, size, false);
  context.stroke();
}

export function strokeSquareNode(context, position, size) {
  nodePath(context, position, size, true);
  context.stroke();
}
