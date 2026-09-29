import { pointInRect } from "@fontra/core/rectangle.ts";
import { withSavedState } from "@fontra/core/utils.ts";
import { mulScalar } from "@fontra/core/var-funcs.js";
import { VarPackedPath } from "@fontra/core/var-path.js";
import {
  fillRoundNode,
  getVisualizationLayerDefinitions,
  registerVisualizationLayerDefinition,
  strokeRoundNode,
  strokeSquareNode,
} from "../vendor/fontra/tools/support.js";
import { makeFillStyle } from "./gradients.js";

export class VisualizationLayers {
  constructor(darkTheme) {
    this._darkTheme = darkTheme;
    this._scaleFactor = 1;
    this.requestUpdate = () => {
      delete this.layers;
    };
  }

  get scaleFactor() {
    return this._scaleFactor;
  }

  set scaleFactor(scaleFactor) {
    this._scaleFactor = scaleFactor;
    this.requestUpdate();
  }

  buildLayers() {
    const layers = [];
    const definitions = [...getVisualizationLayerDefinitions()].sort(
      (a, b) => (a.zIndex || 0) - (b.zIndex || 0)
    );
    for (const layerDef of definitions) {
      if (layerDef.userSwitchable && layerDef.defaultOn === false) {
        continue;
      }
      const parameters = {
        ...mulScalar(layerDef.screenParameters || {}, this.scaleFactor),
        ...(layerDef.glyphParameters || {}),
        ...(layerDef.colors || {}),
        ...(this._darkTheme && layerDef.colorsDarkMode ? layerDef.colorsDarkMode : {}),
      };
      layers.push({
        selectionFunc: layerDef.selectionFunc,
        parameters,
        draw: layerDef.draw,
      });
    }
    this.layers = layers;
  }

  drawVisualizationLayers(visContext) {
    if (!this.layers) {
      this.buildLayers();
    }
    const { model, controller } = visContext;
    const context = controller.context;
    for (const layer of this.layers) {
      for (const item of layer.selectionFunc(visContext, layer)) {
        withSavedState(context, () => {
          context.translate(item.x, item.y);
          layer.draw(context, item, layer.parameters, model, controller);
        });
      }
    }
  }
}

export function makeVisContext(model, controller) {
  const selectedPositionedGlyph = model.getSelectedPositionedGlyph();
  const shapes = model.document.shapes;
  const all = shapes.map((shape, i) => model.positionedGlyphForShape(shape, i));
  const hoveredGlyph = model.getHoveredPositionedGlyph();
  return {
    model,
    controller,
    glyphsBySelectionMode: {
      all,
      unselected: all.filter((g) => g !== selectedPositionedGlyph),
      hovered: hoveredGlyph ? [hoveredGlyph] : [],
      selected:
        model.selectedGlyph && !model.selectedGlyph.isEditing && selectedPositionedGlyph
          ? [selectedPositionedGlyph]
          : [],
      editing: model.selectedGlyph?.isEditing && selectedPositionedGlyph
        ? [selectedPositionedGlyph]
        : [],
      notediting: all.filter(
        (g) => g !== selectedPositionedGlyph || !model.selectedGlyph?.isEditing
      ),
    },
  };
}

// --- Our own layer definitions ---

registerVisualizationLayerDefinition({
  identifier: "vs.shape.fill",
  zIndex: 0,
  selectionFunc: (visContext) => visContext.glyphsBySelectionMode.all,
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const shape = model.document.shapeAt(positionedGlyph.glyphIndex);
    if (!shape.visible) {
      return;
    }
    const path = shape.path;
    if (!path.numPoints) {
      return;
    }
    const path2d = new Path2D();
    path.drawToPath2d(path2d);
    if (shape.fill) {
      const style = makeFillStyle(context, shape.fill, path.getControlBounds());
      if (style) {
        context.fillStyle = style;
        context.fill(path2d);
      }
    }
    if (shape.stroke && shape.strokeWidth > 0) {
      context.strokeStyle = shape.stroke;
      context.lineWidth = shape.strokeWidth;
      context.stroke(path2d);
    }
  },
});

registerVisualizationLayerDefinition({
  identifier: "vs.shape.outline",
  zIndex: 100,
  screenParameters: { strokeWidth: 1 },
  colors: { strokeColor: "#2f6bff" },
  selectionFunc: (visContext) => visContext.glyphsBySelectionMode.all,
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const shape = model.document.shapeAt(positionedGlyph.glyphIndex);
    if (!shape.visible || !shape.path.numPoints) {
      return;
    }
    const isEditing =
      model.selectedGlyph?.isEditing &&
      model.selectedGlyph.glyphIndex === positionedGlyph.glyphIndex;
    const isSelected =
      model.selectedGlyph && model.selectedGlyph.glyphIndex === positionedGlyph.glyphIndex;
    if (!isEditing && !isSelected) {
      return;
    }
    context.strokeStyle = parameters.strokeColor;
    context.lineWidth = parameters.strokeWidth;
    const outlinePath = new Path2D();
    shape.path.drawToPath2d(outlinePath);
    context.stroke(outlinePath);
  },
});

registerVisualizationLayerDefinition({
  identifier: "vs.editing.nodes",
  zIndex: 300,
  screenParameters: {
    nodeSize: 9,
    handleSize: 6,
    strokeWidth: 1,
    handleLineWidth: 1,
  },
  colors: {
    nodeColor: "#ffffff",
    nodeStrokeColor: "#2f6bff",
    selectedNodeColor: "#2f6bff",
    handleColor: "#ffffff",
    handleStrokeColor: "#999999",
    handleLineColor: "#aaaaaa",
    hoverNodeColor: "#7ba6ff",
  },
  selectionFunc: (visContext) => visContext.glyphsBySelectionMode.editing,
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const path = positionedGlyph.glyph.path;
    const selection = model.selection || new Set();
    const hoverSelection = model.hoverSelection || new Set();
    const scale = parameters.strokeWidth; // == 1 unit in screen px

    // handle lines first (below nodes)
    context.strokeStyle = parameters.handleLineColor;
    context.lineWidth = parameters.handleLineWidth;
    for (let contourIndex = 0; contourIndex < path.numContours; contourIndex++) {
      const start = path.getAbsolutePointIndex(contourIndex, 0);
      const end = path.contourInfo[contourIndex].endPoint;
      let prevOnCurve;
      for (let i = start; i <= end; i++) {
        const point = path.getPoint(i);
        const isOffCurve = (path.pointTypes[i] & VarPackedPath.POINT_TYPE_MASK) !== 0;
        if (isOffCurve && prevOnCurve !== undefined) {
          const anchor = path.getPoint(prevOnCurve);
          strokeLineRaw(context, anchor.x, anchor.y, point.x, point.y);
        } else if (!isOffCurve) {
          prevOnCurve = i;
        }
      }
    }

    for (let i = 0; i < path.numPoints; i++) {
      const point = path.getPoint(i);
      const type = path.pointTypes[i] & VarPackedPath.POINT_TYPE_MASK;
      const isSmooth = !!(path.pointTypes[i] & VarPackedPath.SMOOTH_FLAG);
      const isOffCurve = type !== VarPackedPath.ON_CURVE;
      const key = `point/${i}`;
      const isSelected = selection.has(key);
      const isHovered = hoverSelection.has(key);

      if (isOffCurve) {
        context.fillStyle = isSelected ? parameters.selectedNodeColor : parameters.handleColor;
        context.strokeStyle = parameters.handleStrokeColor;
        context.lineWidth = parameters.strokeWidth;
        fillRoundNode(context, point, parameters.handleSize);
        nodeStroke(context, point, parameters.handleSize, true);
      } else {
        context.fillStyle = isSelected
          ? parameters.selectedNodeColor
          : isHovered
            ? parameters.hoverNodeColor
            : parameters.nodeColor;
        context.strokeStyle = parameters.nodeStrokeColor;
        context.lineWidth = parameters.strokeWidth;
        if (isSmooth) {
          fillRoundNode(context, point, parameters.nodeSize);
          nodeStroke(context, point, parameters.nodeSize, true);
        } else {
          nodeFillSquare(context, point, parameters.nodeSize);
          nodeStroke(context, point, parameters.nodeSize, false);
        }
      }
    }

    // hover path highlight
    if (model.hoverPathHit?.segment) {
      // subtle: nothing extra for now, nodes highlight suffices
    }
  },
});

registerVisualizationLayerDefinition({
  identifier: "vs.selection.rect",
  zIndex: 600,
  screenParameters: { strokeWidth: 1 },
  colors: { strokeColor: "#2f6bff", fillColor: "#2f6bff22" },
  selectionFunc: (visContext) => visContext.glyphsBySelectionMode.editing,
  draw: (context, positionedGlyph, parameters, model, controller) => {
    const rect = model.selectionRect;
    if (!rect) {
      return;
    }
    context.fillStyle = parameters.fillColor;
    context.fillRect(
      rect.xMin,
      rect.yMin,
      rect.xMax - rect.xMin,
      rect.yMax - rect.yMin
    );
    context.strokeStyle = parameters.strokeColor;
    context.lineWidth = parameters.strokeWidth;
    context.strokeRect(
      rect.xMin,
      rect.yMin,
      rect.xMax - rect.xMin,
      rect.yMax - rect.yMin
    );
  },
});

registerVisualizationLayerDefinition({
  identifier: "vs.pen.preview",
  zIndex: 550,
  screenParameters: { nodeSize: 10, strokeWidth: 2 },
  colors: { insertColor: "#2f6bff", connectColor: "#24a148" },
  selectionFunc: (visContext) => visContext.glyphsBySelectionMode.editing,
  draw: (context, positionedGlyph, parameters, model, controller) => {
    if (model.pathInsertHandles) {
      context.strokeStyle = parameters.insertColor;
      context.lineWidth = parameters.strokeWidth;
      for (const handle of model.pathInsertHandles.points) {
        strokeRoundNode(context, handle, parameters.nodeSize);
      }
    }
    if (model.pathConnectTargetPoint) {
      context.strokeStyle = parameters.connectColor;
      context.lineWidth = parameters.strokeWidth;
      strokeRoundNode(context, model.pathConnectTargetPoint, parameters.nodeSize + 2);
    }
    if (model.pathDanglingOffCurve) {
      context.fillStyle = parameters.insertColor;
      fillRoundNode(context, model.pathDanglingOffCurve, parameters.nodeSize - 2);
    }
  },
});

function strokeLineRaw(context, x1, y1, x2, y2) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function nodeStroke(context, position, size, round) {
  context.beginPath();
  if (round) {
    context.arc(position.x, position.y, size / 2, 0, 2 * Math.PI);
  } else {
    context.rect(position.x - size / 2, position.y - size / 2, size, size);
  }
  context.stroke();
}

function nodeFillSquare(context, position, size) {
  context.fillRect(position.x - size / 2, position.y - size / 2, size, size);
}
