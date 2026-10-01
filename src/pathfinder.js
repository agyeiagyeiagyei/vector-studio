// Pathfinder boolean ops: flatten shape paths to polygons (bezier-js LUTs),
// combine with polygon-clipping, rebuild a single result shape.
import { Bezier } from "bezier-js";
import polygonClipping from "polygon-clipping";
import { VarPackedPath } from "@fontra/core/var-path.js";
import { Shape } from "./document.js";
import { selectedShapes } from "./transform.js";

// Flatten one shape to a MultiPolygon in absolute coords.
// Rings are grouped outer/holes by even-odd nesting and wound outer=CCW.
export function shapeToMultiPolygon(shape) {
  const rings = [];
  for (let ci = 0; ci < shape.path.numContours; ci++) {
    for (const ring of flattenContour(shape, ci)) {
      rings.push(ring);
    }
  }
  return groupRings(rings);
}

function flattenContour(shape, contourIndex) {
  const pts = [];
  for (const segment of shape.path.iterContourDecomposedSegments(contourIndex)) {
    const sp = segment.points;
    if (sp.length < 2) {
      continue;
    }
    if (!pts.length) {
      pts.push([sp[0].x + shape.x, sp[0].y + shape.y]);
    }
    if (sp.length === 2) {
      pts.push([sp[1].x + shape.x, sp[1].y + shape.y]);
    } else {
      const ctrlLen = sp
        .slice(1)
        .reduce((acc, p, i) => acc + Math.hypot(p.x - sp[i].x, p.y - sp[i].y), 0);
      const steps = Math.min(64, Math.max(8, Math.ceil(ctrlLen / 4)));
      const lut = new Bezier(sp.map((p) => ({ x: p.x + shape.x, y: p.y + shape.y }))).getLUT(steps);
      for (const p of lut.slice(1)) {
        pts.push([p.x, p.y]);
      }
    }
  }
  if (pts.length > 2) {
    // Drop a duplicated closing point; polygon-clipping closes rings itself.
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) {
      pts.pop();
    }
  }
  return pts.length >= 3 ? [pts] : [];
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Even-odd nesting: ring depth = how many other rings contain it; even depth
// is an outer ring, odd depth a hole of the polygon its parent started.
function groupRings(rings) {
  const depth = rings.map((ring, i) => {
    const [x, y] = ring[0];
    let d = 0;
    for (let j = 0; j < rings.length; j++) {
      if (j !== i && pointInRing(x, y, rings[j])) {
        d++;
      }
    }
    return d;
  });
  const order = rings.map((_, i) => i).sort((a, b) => depth[a] - depth[b]);
  const polygons = [];
  const polyAtDepth = [];
  for (const i of order) {
    const ring = rings[i];
    if (depth[i] % 2 === 0) {
      const r = signedArea(ring) < 0 ? [...ring].reverse() : ring;
      polygons.push([r]);
      polyAtDepth[depth[i]] = polygons[polygons.length - 1];
    } else {
      const parent = polyAtDepth[depth[i] - 1];
      if (!parent) {
        continue;
      }
      parent.push(signedArea(ring) > 0 ? [...ring].reverse() : ring);
    }
  }
  return polygons;
}

function multiPolygonToPath(mp) {
  const path = new VarPackedPath();
  for (const polygon of mp) {
    for (const ring of polygon) {
      if (ring.length < 3) {
        continue;
      }
      path.moveTo(round(ring[0][0]), round(ring[0][1]));
      for (const [x, y] of ring.slice(1)) {
        path.lineTo(round(x), round(y));
      }
      path.closePath();
    }
  }
  return path;
}

function round(v) {
  return Math.round(v * 100) / 100;
}

// op: "unite" | "subtract" | "intersect" | "exclude"
export function applyPathfinder(editor, op) {
  const shapes = selectedShapes(editor).filter((s) => !s.locked && s.path.numPoints > 0);
  if (shapes.length < 2) {
    return null;
  }
  const mps = shapes.map(shapeToMultiPolygon);
  const ops = {
    unite: polygonClipping.union,
    subtract: polygonClipping.difference,
    intersect: polygonClipping.intersection,
    exclude: polygonClipping.xor,
  };
  const fn = ops[op];
  let result;
  try {
    result = mps.reduce((acc, mp) => fn(acc, mp));
  } catch (error) {
    console.error("pathfinder failed", error);
    return null;
  }
  if (!result.length) {
    return null;
  }

  // Topmost shape (later in z-order) donates its style.
  const top = shapes.reduce((a, b) =>
    editor.document.indexOfShape(a) > editor.document.indexOfShape(b) ? a : b
  );
  const removed = shapes
    .map((shape) => ({ shape, index: editor.document.indexOfShape(shape) }))
    .sort((a, b) => b.index - a.index);
  const insertAt = Math.min(...removed.map((r) => r.index));

  const resultShape = new Shape(`${top.name} ${op}`);
  resultShape.layerGlyph.path = multiPolygonToPath(result);
  resultShape.fill = top.fill;
  resultShape.stroke = top.stroke;
  resultShape.strokeWidth = top.strokeWidth;

  const removeOriginals = () => {
    editor.sceneSettings.selectedGlyph = undefined;
    for (const { shape } of removed) {
      const idx = editor.document.indexOfShape(shape);
      if (idx >= 0) {
        editor.document.removeShapeAt(idx);
      }
    }
  };
  const addResult = () => {
    const index = editor.document.addShape(
      resultShape,
      Math.min(insertAt, editor.document.shapes.length)
    );
    editor.sceneSettings.selectedGlyph = { lineIndex: 0, glyphIndex: index, isEditing: false };
  };
  const restoreOriginals = () => {
    editor.sceneSettings.selectedGlyph = undefined;
    const idx = editor.document.indexOfShape(resultShape);
    if (idx >= 0) {
      editor.document.removeShapeAt(idx);
    }
    for (const { shape, index } of [...removed].reverse()) {
      editor.document.addShape(shape, Math.min(index, editor.document.shapes.length));
    }
  };

  removeOriginals();
  addResult();
  editor.extraSelected.clear();
  editor.document.pushUndo({
    label: `pathfinder ${op}`,
    undo: () => {
      restoreOriginals();
      editor.canvasController.requestUpdate();
      editor.updateLayersPanel();
    },
    redo: () => {
      removeOriginals();
      addResult();
      editor.canvasController.requestUpdate();
      editor.updateLayersPanel();
    },
  });
  editor.canvasController.requestUpdate();
  editor.updateLayersPanel();
  editor.updateStylePanel();
  editor.updateTransformPanel?.();
  editor.updatePathfinderPanel?.();
  return resultShape;
}
