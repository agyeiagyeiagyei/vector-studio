// Whole-shape transforms: multi-select model, numeric scale/rotate/flip,
// baked into path points around the collective bounding-box pivot.
import { Transform } from "@fontra/core/transform.js";
import { relayoutTextShape } from "./text.js";

export function selectedShapes(editor) {
  const shapes = [];
  const primary = editor.sceneSettings.selectedGlyph;
  if (primary) {
    const shape = editor.document.shapeAt(primary.glyphIndex);
    if (shape) {
      shapes.push(shape);
    }
  }
  for (const shape of editor.extraSelected) {
    if (editor.document.shapes.includes(shape) && !shapes.includes(shape)) {
      shapes.push(shape);
    }
  }
  return shapes;
}

export function shapeBounds(shape) {
  const b = shape.path.getBounds();
  if (!b) {
    return null;
  }
  return {
    xMin: b.xMin + shape.x,
    yMin: b.yMin + shape.y,
    xMax: b.xMax + shape.x,
    yMax: b.yMax + shape.y,
  };
}

function collectiveBounds(shapes) {
  let bounds = null;
  for (const shape of shapes) {
    const b = shapeBounds(shape);
    if (!b) {
      continue;
    }
    bounds = bounds
      ? {
          xMin: Math.min(bounds.xMin, b.xMin),
          yMin: Math.min(bounds.yMin, b.yMin),
          xMax: Math.max(bounds.xMax, b.xMax),
          yMax: Math.max(bounds.yMax, b.yMax),
        }
      : b;
  }
  return bounds;
}

export function applyTransform(editor, { scaleX = 1, scaleY = 1, rotateDeg = 0 } = {}) {
  const shapes = selectedShapes(editor).filter((s) => !s.locked);
  if (!shapes.length) {
    return false;
  }
  if (Math.abs(rotateDeg) < 1e-9 && Math.abs(scaleX) < 1e-9 && Math.abs(scaleY) < 1e-9) {
    return false;
  }
  const bounds = collectiveBounds(shapes);
  if (!bounds) {
    return false;
  }
  const cx = (bounds.xMin + bounds.xMax) / 2;
  const cy = (bounds.yMin + bounds.yMax) / 2;
  let t = new Transform().translate(cx, cy);
  if (Math.abs(rotateDeg) > 1e-9) {
    t = t.rotate((rotateDeg * Math.PI) / 180);
  }
  t = t.scale(scaleX, scaleY);
  t = t.translate(-cx, -cy);

  const snapshots = shapes.map((shape) => ({
    shape,
    path: shape.path.copy(),
    x: shape.x,
    y: shape.y,
    size: shape.text?.size,
  }));

  const apply = (useSnapshots) => {
    for (const snap of snapshots) {
      const { shape } = snap;
      if (useSnapshots) {
        shape.layerGlyph.path = snap.path.copy();
        shape.x = snap.x;
        shape.y = snap.y;
        if (shape.text && snap.size !== undefined) {
          shape.text.size = snap.size;
          relayoutTextShape(editor.fonts, shape);
        }
        editor.sceneController._shapeChanged(shape);
        continue;
      }
      if (shape.text) {
        // Live text stays upright: transform its origin, scale its size.
        const [nx, ny] = t.transformPoint(shape.x, shape.y);
        shape.x = Math.round(nx);
        shape.y = Math.round(ny);
        const factor = Math.sqrt(Math.abs(scaleX * scaleY));
        if (factor > 1e-9 && Math.abs(factor - 1) > 1e-9) {
          shape.text.size = Math.max(4, Math.round(shape.text.size * factor));
          relayoutTextShape(editor.fonts, shape);
        }
      } else {
        const n = shape.path.numPoints;
        for (let i = 0; i < n; i++) {
          const p = shape.path.getPoint(i);
          const [nx, ny] = t.transformPoint(p.x + shape.x, p.y + shape.y);
          shape.path.setPointPosition(i, nx - shape.x, ny - shape.y);
        }
      }
      editor.sceneController._shapeChanged(shape);
    }
  };

  apply(false);
  editor.document.pushUndo({
    label: "transform",
    undo: () => {
      apply(true);
      editor.canvasController.requestUpdate();
    },
    redo: () => {
      apply(false);
      editor.canvasController.requestUpdate();
    },
  });
  editor.canvasController.requestUpdate();
  editor.updateLayersPanel?.();
  editor.updateStylePanel?.();
  editor.updateTextPanel?.();
  editor.updateTransformPanel?.();
  editor.updatePathfinderPanel?.();
  return true;
}
