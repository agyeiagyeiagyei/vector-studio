// Curvature pen: click to drop anchors, the curve is auto-fitted through them
// (Catmull-Rom → cubic Bézier). Click the first anchor to close, double-click
// an anchor to toggle corner/smooth, drag an anchor to move it, Delete removes
// the last anchor. Escape exits; the baked path is plain cubic Béziers.

import { VarPackedPath } from "@fontra/core/var-path.js";
import { BaseTool } from "../vendor/fontra/tools/edit-tools-base.js";

export function curvatureToContour(anchors, closed) {
  const n = anchors.length;
  const points = [{ x: anchors[0].x, y: anchors[0].y }];
  if (n < 2) {
    return { isClosed: false, points };
  }
  const at = (i) =>
    anchors[closed ? ((i % n) + n) % n : Math.max(0, Math.min(i, n - 1))];
  const handles = (i) => {
    const p0 = at(i);
    const p1 = at(i + 1);
    const pm = at(i - 1);
    const p2 = at(i + 2);
    const c1 = p0.corner
      ? p0
      : { x: p0.x + (p1.x - pm.x) / 6, y: p0.y + (p1.y - pm.y) / 6 };
    const c2 = p1.corner
      ? p1
      : { x: p1.x - (p2.x - p0.x) / 6, y: p1.y - (p2.y - p0.y) / 6 };
    return [
      { x: c1.x, y: c1.y, type: "cubic" },
      { x: c2.x, y: c2.y, type: "cubic" },
    ];
  };
  const segCount = closed ? n - 1 : n - 1;
  for (let i = 0; i < segCount; i++) {
    points.push(...handles(i), { x: at(i + 1).x, y: at(i + 1).y });
  }
  if (closed) {
    // closing segment wraps to points[0]: trailing off-curves, no duplicate on-curve
    points.push(...handles(n - 1));
  }
  return { isClosed: closed, points };
}

function snapshot(contours) {
  return JSON.parse(JSON.stringify(contours));
}

export class CurvaturePenTool extends BaseTool {
  identifier = "pen-tool-curvature";

  setCursor() {
    this.canvasController.canvas.style.cursor = "crosshair";
  }

  handleHover(event) {
    if (!this._inSession()) {
      this.editor.tools["pointer-tool"].handleHover(event);
      return;
    }
    this.setCursor();
  }

  _inSession() {
    const sel = this.sceneModel.selectedGlyph;
    return (
      sel?.isEditing &&
      this.shape &&
      this.editor.document.shapeAt(sel.glyphIndex) === this.shape
    );
  }

  get _activeContour() {
    const last = this.contours[this.contours.length - 1];
    return last && !last.closed ? last : undefined;
  }

  _refit() {
    const contours = this.contours
      .filter((c) => c.anchors.length)
      .map((c) => curvatureToContour(c.anchors, c.closed));
    this.shape.layerGlyph.path = VarPackedPath.fromUnpackedContours(contours);
    this.sceneController._shapeChanged(this.shape);
  }

  _pushUndo(label, before, after) {
    const shape = this.shape;
    this.editor.document.pushUndo({
      label,
      undo: () => {
        if (this.shape === shape) {
          this.contours = snapshot(before);
        }
        shape.layerGlyph.path = VarPackedPath.fromUnpackedContours(
          before
            .filter((c) => c.anchors.length)
            .map((c) => curvatureToContour(c.anchors, c.closed))
        );
        this.sceneController._shapeChanged(shape);
      },
      redo: () => {
        if (this.shape === shape) {
          this.contours = snapshot(after);
        }
        shape.layerGlyph.path = VarPackedPath.fromUnpackedContours(
          after
            .filter((c) => c.anchors.length)
            .map((c) => curvatureToContour(c.anchors, c.closed))
        );
        this.sceneController._shapeChanged(shape);
      },
    });
  }

  _hitAnchor(point, margin) {
    let best;
    for (let ci = 0; ci < this.contours.length; ci++) {
      const anchors = this.contours[ci].anchors;
      for (let ai = 0; ai < anchors.length; ai++) {
        const d = Math.hypot(anchors[ai].x - point.x, anchors[ai].y - point.y);
        if (d <= margin && (!best || d < best.d)) {
          best = { d, contourIndex: ci, anchorIndex: ai };
        }
      }
    }
    return best;
  }

  async handleDrag(eventStream, initialEvent) {
    if (!this._inSession()) {
      this.shape = this.editor.createShapeAndEnterEditing();
      this.contours = [];
      this._lastClick = undefined;
    }
    const point = this.sceneController.selectedGlyphPoint(initialEvent);
    if (point.x === undefined) {
      eventStream.done();
      return;
    }
    const margin = this.sceneController.mouseClickMargin;
    const hit = this._hitAnchor(point, margin);
    const active = this._activeContour;

    // Click the first anchor of the open contour: close it.
    if (hit && active && hit.contourIndex === this.contours.length - 1 &&
        hit.anchorIndex === 0 && active.anchors.length >= 3) {
      const before = snapshot(this.contours);
      active.closed = true;
      this._refit();
      this._pushUndo("close contour", before, snapshot(this.contours));
      eventStream.done();
      return;
    }

    // Hit an existing anchor: double-click toggles corner, otherwise drag it.
    if (hit) {
      const now = performance.now();
      const last = this._lastClick;
      this._lastClick = { ...hit, t: now };
      const anchor = this.contours[hit.contourIndex].anchors[hit.anchorIndex];
      if (
        last &&
        last.contourIndex === hit.contourIndex &&
        last.anchorIndex === hit.anchorIndex &&
        now - last.t < 450
      ) {
        const before = snapshot(this.contours);
        anchor.corner = !anchor.corner;
        this._refit();
        this._pushUndo("toggle corner", before, snapshot(this.contours));
        this._lastClick = undefined;
        eventStream.done();
        return;
      }
      const before = snapshot(this.contours);
      let moved = false;
      for await (const event of eventStream) {
        const p = this.sceneController.selectedGlyphPoint(event);
        if (p.x === undefined) {
          continue;
        }
        anchor.x = Math.round(p.x);
        anchor.y = Math.round(p.y);
        moved = true;
        this._refit();
      }
      if (moved) {
        this._pushUndo("move point", before, snapshot(this.contours));
      }
      return;
    }

    // Empty space: append an anchor (new contour if the last one is closed).
    const before = snapshot(this.contours);
    let contour = this._activeContour;
    if (!contour) {
      contour = { anchors: [], closed: false };
      this.contours.push(contour);
    }
    const anchor = { x: Math.round(point.x), y: Math.round(point.y), corner: false };
    contour.anchors.push(anchor);
    this._refit();
    // Dragging right after placing moves the new anchor.
    for await (const event of eventStream) {
      const p = this.sceneController.selectedGlyphPoint(event);
      if (p.x === undefined) {
        continue;
      }
      anchor.x = Math.round(p.x);
      anchor.y = Math.round(p.y);
      this._refit();
    }
    this._pushUndo("add point", before, snapshot(this.contours));
  }

  // Returns true if it consumed the key. Delete removes the last anchor.
  handleDelete() {
    if (!this._inSession()) {
      return false;
    }
    const contour = this._activeContour || this.contours[this.contours.length - 1];
    if (!contour || !contour.anchors.length) {
      return false;
    }
    const before = snapshot(this.contours);
    contour.anchors.pop();
    if (!contour.anchors.length) {
      this.contours.splice(this.contours.indexOf(contour), 1);
    }
    this._refit();
    this._pushUndo("delete point", before, snapshot(this.contours));
    return true;
  }

  deactivate() {
    super.deactivate();
    this.shape = undefined;
    this.contours = [];
  }
}
