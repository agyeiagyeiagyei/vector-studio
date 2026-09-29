import { recordChanges } from "@fontra/core/change-recorder.js";
import { applyChange, hasChange } from "@fontra/core/changes.js";
import { pointInConvexPolygon } from "@fontra/core/convex-hull.js";
import { PathHitTester } from "@fontra/core/path-hit-tester.js";
import { filterPathByPointIndices } from "@fontra/core/path-functions.js";
import { centeredRect, offsetRect, pointInRect } from "@fontra/core/rectangle.ts";
import { parseSelection, range, reversed, withTimeout } from "@fontra/core/utils.ts";
import * as vector from "@fontra/core/vector.js";

const scratchCanvas = document.createElement("canvas");
const scratchContext = scratchCanvas.getContext("2d");

export function isPointInPath(path2d, x, y) {
  return scratchContext.isPointInPath(path2d, x, y);
}

export class SceneSettings {
  constructor() {
    this._selectedGlyph = undefined; // {lineIndex: 0, glyphIndex, isEditing}
    this.selection = new Set();
    this.guardSelectedGlyph = undefined; // optional (value) => value, e.g. text shapes never edit nodes
  }

  get selectedGlyph() {
    return this._selectedGlyph;
  }

  set selectedGlyph(value) {
    this._selectedGlyph = this.guardSelectedGlyph ? this.guardSelectedGlyph(value) : value;
  }
}

// GlyphController-like facade over a Shape, exposing exactly what the
// vendored tools consume.
export class ShapeGlyphController {
  constructor(shape) {
    this.shape = shape;
    this._cacheVersion = -1;
  }

  get layerName() {
    return "main";
  }

  get canEdit() {
    return !this.shape.locked;
  }

  get instance() {
    return this.shape.layerGlyph;
  }

  get path() {
    return this.shape.layerGlyph.path;
  }

  get components() {
    return [];
  }

  get anchors() {
    return this.shape.layerGlyph.anchors;
  }

  get guidelines() {
    return this.shape.layerGlyph.guidelines;
  }

  get backgroundImage() {
    return undefined;
  }

  _ensureCache() {
    if (this._cacheVersion !== this.shape._version || this._cachedPath !== this.path) {
      this._cachedPath = this.path;
      this._cacheVersion = this.shape._version;
      this._pathHitTester = new PathHitTester(this.path);
      this._convexHull = this.path.getConvexHull();
      this._flattenedPath2d = new Path2D();
      this.path.drawToPath2d(this._flattenedPath2d);
      this._controlBounds = this.path.getControlBounds();
      this._convexHullArea = polygonArea(this._convexHull);
    }
  }

  get pathHitTester() {
    this._ensureCache();
    return this._pathHitTester;
  }

  get convexHull() {
    this._ensureCache();
    return this._convexHull;
  }

  get convexHullArea() {
    this._ensureCache();
    return this._convexHullArea;
  }

  get flattenedPath2d() {
    this._ensureCache();
    return this._flattenedPath2d;
  }

  get controlBounds() {
    this._ensureCache();
    return this._controlBounds;
  }

  getSelectionBounds(selection, getBackgroundImageBoundsFunc = undefined) {
    if (!selection.size) {
      return undefined;
    }
    const { point: pointIndices, anchor: anchorIndices } = parseSelection(selection);
    const selectionRects = [];
    if (pointIndices?.length) {
      const pathBounds = filterPathByPointIndices(
        this.instance.path,
        pointIndices
      ).getBounds();
      if (pathBounds) {
        selectionRects.push(pathBounds);
      }
    }
    for (const anchorIndex of anchorIndices || []) {
      const anchor = this.instance.anchors[anchorIndex];
      if (anchor) {
        selectionRects.push(centeredRect(anchor.x, anchor.y, 0));
      }
    }
    if (!selectionRects.length) {
      return undefined;
    }
    return selectionRects.reduce((acc, rect) => unionRect(acc, rect));
  }
}

function polygonArea(points) {
  if (!points || points.length < 3) {
    return 0;
  }
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

function unionRect(a, b) {
  return {
    xMin: Math.min(a.xMin, b.xMin),
    yMin: Math.min(a.yMin, b.yMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMax: Math.max(a.yMax, b.yMax),
  };
}

export class SceneModel {
  constructor(documentModel, sceneController) {
    this.document = documentModel;
    this.sceneController = sceneController;
    this._controllers = new Map(); // shape -> controller facade
  }

  get sceneSettings() {
    return this.sceneController.sceneSettings;
  }

  get selectedGlyph() {
    return this.sceneSettings.selectedGlyph;
  }

  get selection() {
    return this.sceneSettings.selection;
  }

  get fontController() {
    return { getBackgroundImageBoundsFunc: undefined };
  }

  get hoverSelection() {
    return this.sceneController.hoverSelection;
  }

  get hoverPathHit() {
    return this.sceneController.hoverPathHit;
  }

  get selectionRect() {
    return this.sceneController.selectionRect;
  }

  get canEdit() {
    const shape = this._selectedShape();
    return !!this.selectedGlyph?.isEditing && !!shape && !shape.locked;
  }

  get showTransformSelection() {
    return this._showTransformSelection !== false;
  }

  set showTransformSelection(value) {
    this._showTransformSelection = value;
  }

  _selectedShape() {
    const sel = this.selectedGlyph;
    return sel ? this.document.shapeAt(sel.glyphIndex) : undefined;
  }

  controllerForShape(shape) {
    let controller = this._controllers.get(shape);
    if (!controller) {
      controller = new ShapeGlyphController(shape);
      this._controllers.set(shape, controller);
    }
    return controller;
  }

  positionedGlyphForShape(shape, glyphIndex) {
    return {
      x: shape.x,
      y: shape.y,
      glyph: this.controllerForShape(shape),
      varGlyph: { glyph: shape.glyphData },
      glyphName: shape.name,
      isUndefined: false,
      get isEmpty() {
        return shape.path.numPoints === 0;
      },
      get bounds() {
        const b = shape.path.getControlBounds();
        return b ? offsetRect(b, shape.x, shape.y) : undefined;
      },
      lineIndex: 0,
      glyphIndex,
    };
  }

  getSelectedPositionedGlyph() {
    const sel = this.selectedGlyph;
    if (!sel) {
      return undefined;
    }
    const shape = this.document.shapeAt(sel.glyphIndex);
    if (!shape) {
      return undefined;
    }
    return this.positionedGlyphForShape(shape, sel.glyphIndex);
  }

  getHoveredPositionedGlyph() {
    const hovered = this.sceneController.hoveredGlyph;
    if (!hovered) {
      return undefined;
    }
    const shape = this.document.shapeAt(hovered.glyphIndex);
    if (!shape) {
      return undefined;
    }
    return this.positionedGlyphForShape(shape, hovered.glyphIndex);
  }

  async getSelectedStaticGlyphController() {
    return this.getSelectedPositionedGlyph()?.glyph;
  }

  selectionAtPoint(point, size, currentSelection, currentHoverSelection, preferTCenter) {
    if (!this.selectedGlyph?.isEditing) {
      return { selection: new Set() };
    }

    let selection = this._selectionAtPoint(point, size, currentSelection);
    if (selection.selection?.size) {
      return selection;
    }
    selection = this._selectionAtPoint(point, size, undefined);
    if (selection.selection?.size) {
      return selection;
    }
    return { selection: new Set() };
  }

  _selectionAtPoint(point, size, currentSelection) {
    const parsedCurrentSelection = currentSelection
      ? parseSelection(currentSelection)
      : undefined;

    const anchorSelection = this.anchorSelectionAtPoint(
      point,
      size,
      parsedCurrentSelection
    );
    if (anchorSelection.size) {
      return { selection: anchorSelection };
    }

    const pointSelection = this.pointSelectionAtPoint(
      point,
      size,
      parsedCurrentSelection
    );
    if (pointSelection.size) {
      return { selection: pointSelection };
    }

    const segmentSelection = this.segmentSelectionAtPoint(
      point,
      size,
      parsedCurrentSelection
    );
    if (segmentSelection.pathHit) {
      return segmentSelection;
    }

    return {};
  }

  pointSelectionAtPoint(point, size, parsedCurrentSelection) {
    const positionedGlyph = this.getSelectedPositionedGlyph();
    if (!positionedGlyph) {
      return new Set();
    }

    const glyphPoint = {
      x: point.x - positionedGlyph.x,
      y: point.y - positionedGlyph.y,
    };

    let pointIndex;
    if (parsedCurrentSelection) {
      pointIndex = positionedGlyph.glyph.path.pointIndexNearPointFromPointIndices(
        glyphPoint,
        size,
        parsedCurrentSelection.point || []
      );
    } else {
      pointIndex = positionedGlyph.glyph.path.pointIndexNearPoint(glyphPoint, size);
    }
    if (pointIndex !== undefined) {
      return new Set([`point/${pointIndex}`]);
    }
    return new Set();
  }

  segmentSelectionAtPoint(point, size, parsedCurrentSelection) {
    const pathHit = this.pathHitAtPoint(point, size);

    const pointIndices = parsedCurrentSelection
      ? (parsedCurrentSelection.point ?? [])
      : undefined;

    if (
      pointIndices &&
      pathHit.segment &&
      !(
        pointIndices.includes(pathHit.segment.parentPointIndices[0]) &&
        pointIndices.includes(pathHit.segment.parentPointIndices.at(-1))
      )
    ) {
      return { selection: new Set() };
    }

    if (
      !pathHit.segment?.parentPoints.every(
        (point) => vector.distance(pathHit, point) > size
      )
    ) {
      return { selection: new Set() };
    }

    return {
      selection: new Set(
        [
          pathHit.segment.parentPointIndices[0],
          pathHit.segment.parentPointIndices.at(-1),
        ].map((i) => `point/${i}`)
      ),
      pathHit,
    };
  }

  anchorSelectionAtPoint(point, size, parsedCurrentSelection) {
    const positionedGlyph = this.getSelectedPositionedGlyph();
    if (!positionedGlyph) {
      return new Set();
    }
    const anchors = positionedGlyph.glyph.anchors;
    if (!anchors.length) {
      return new Set();
    }
    const x = point.x - positionedGlyph.x;
    const y = point.y - positionedGlyph.y;
    const selRect = centeredRect(x, y, size);
    const indices = parsedCurrentSelection
      ? parsedCurrentSelection.anchor || []
      : [...range(anchors.length)];
    for (const i of reversed(indices)) {
      const anchor = anchors[i];
      if (anchor && pointInRect(anchor.x, anchor.y, selRect)) {
        return new Set([`anchor/${i}`]);
      }
    }
    return new Set();
  }

  selectionAtRect(selRect, pointFilterFunc) {
    const selection = new Set();
    if (!this.selectedGlyph?.isEditing) {
      return selection;
    }
    const positionedGlyph = this.getSelectedPositionedGlyph();
    if (!positionedGlyph) {
      return selection;
    }
    selRect = offsetRect(selRect, -positionedGlyph.x, -positionedGlyph.y);
    for (const hit of positionedGlyph.glyph.path.iterPointsInRect(selRect)) {
      if (!pointFilterFunc || pointFilterFunc(hit)) {
        selection.add(`point/${hit.pointIndex}`);
      }
    }
    return selection;
  }

  pathHitAtPoint(point, size) {
    if (!this.selectedGlyph?.isEditing) {
      return {};
    }
    const positionedGlyph = this.getSelectedPositionedGlyph();
    if (!positionedGlyph) {
      return {};
    }
    const glyphPoint = {
      x: point.x - positionedGlyph.x,
      y: point.y - positionedGlyph.y,
    };
    return positionedGlyph.glyph.pathHitTester.hitTest(glyphPoint, size / 2);
  }

  glyphAtPoint(point, skipEditingGlyph = true) {
    const matches = [];
    const shapes = this.document.shapes;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const shape = shapes[i];
      if (!shape.visible) {
        continue;
      }
      const controller = this.controllerForShape(shape);
      const bounds = controller.controlBounds;
      if (
        !bounds ||
        !pointInRect(
          point.x,
          point.y,
          offsetRect(bounds, shape.x, shape.y)
        )
      ) {
        continue;
      }
      if (
        shape.path.numPoints === 0 ||
        pointInConvexPolygon(
          point.x - shape.x,
          point.y - shape.y,
          controller.convexHull
        )
      ) {
        if (
          !skipEditingGlyph ||
          !this.selectedGlyph?.isEditing ||
          this.selectedGlyph.glyphIndex !== i
        ) {
          matches.push(i);
        }
      }
    }
    if (!matches.length) {
      return undefined;
    }
    let foundIndex;
    if (matches.length === 1) {
      foundIndex = matches[0];
    } else {
      const decorated = matches.map((i) => {
        const shape = shapes[i];
        const controller = this.controllerForShape(shape);
        return {
          i,
          inside: isPointInPath(
            controller.flattenedPath2d,
            point.x - shape.x,
            point.y - shape.y
          ),
          area: controller.convexHullArea,
        };
      });
      decorated.sort((a, b) => b.inside - a.inside || a.area - b.area);
      foundIndex = decorated[0].i;
    }
    return { lineIndex: 0, glyphIndex: foundIndex };
  }
}

class PathConnectDetector {
  constructor(sceneController, path) {
    this.sceneController = sceneController;
    this.path = path;
    const selection = sceneController.selection;
    if (selection.size !== 1) {
      return;
    }
    const { point: pointSelection } = parseSelection(selection);
    if (
      pointSelection?.length !== 1 ||
      !this.path.isStartOrEndPoint(pointSelection[0])
    ) {
      return;
    }
    this.connectSourcePointIndex = pointSelection[0];
  }

  shouldConnect(showConnectIndicator = false) {
    if (this.connectSourcePointIndex === undefined) {
      return false;
    }

    const sceneController = this.sceneController;
    const connectSourcePoint = this.path.getPoint(this.connectSourcePointIndex);
    const connectTargetPointIndex = this.path.pointIndexNearPoint(
      connectSourcePoint,
      sceneController.mouseClickMargin,
      this.connectSourcePointIndex
    );
    const shouldConnect =
      connectTargetPointIndex !== undefined &&
      connectTargetPointIndex !== this.connectSourcePointIndex &&
      !!this.path.isStartOrEndPoint(connectTargetPointIndex);
    if (showConnectIndicator) {
      if (shouldConnect) {
        sceneController.sceneModel.pathConnectTargetPoint = this.path.getPoint(
          connectTargetPointIndex
        );
      } else {
        delete sceneController.sceneModel.pathConnectTargetPoint;
      }
    }
    this.connectTargetPointIndex = connectTargetPointIndex;
    return shouldConnect;
  }

  clearConnectIndicator() {
    delete this.sceneController.sceneModel.pathConnectTargetPoint;
  }
}

export class SceneController {
  constructor(documentModel, canvasController) {
    this.document = documentModel;
    this.canvasController = canvasController;
    this.sceneSettings = new SceneSettings();
    this.sceneModel = new SceneModel(documentModel, this);
    this.hoverSelection = new Set();
    this.hoverPathHit = undefined;
    this.hoveredGlyph = undefined;
    this.selectionRect = undefined;
    this.applicationSettings = { rectSelectLiveModifierKeys: false };
    this.scrollAdjustBehavior = null;
  }

  get selection() {
    return this.sceneSettings.selection;
  }

  set selection(selection) {
    this.sceneSettings.selection = selection;
    this.canvasController.requestUpdate();
  }

  localPoint(event) {
    return this.canvasController.localPoint(event);
  }

  selectedGlyphPoint(event) {
    const point = this.localPoint(event);
    const positionedGlyph = this.sceneModel.getSelectedPositionedGlyph();
    if (!positionedGlyph) {
      return point;
    }
    return { x: point.x - positionedGlyph.x, y: point.y - positionedGlyph.y };
  }

  get mouseClickMargin() {
    return this.canvasController.onePixelUnit * 12;
  }

  getEditingLayerFromGlyphLayers(glyphLayers) {
    return { main: glyphLayers.main.glyph };
  }

  getPathConnectDetector(path) {
    return new PathConnectDetector(this, path);
  }

  async getStaticGlyphControllers() {
    const controller = await this.sceneModel.getSelectedStaticGlyphController();
    return controller ? { main: controller } : {};
  }

  _dispatchEvent(eventName, detail) {
    this.canvasController.canvas.dispatchEvent(
      new CustomEvent(eventName, { bubbles: false, detail })
    );
  }

  _shapeChanged(shape) {
    shape._version = (shape._version || 0) + 1;
    this.document.notify();
    this.canvasController.requestUpdate();
  }

  async editGlyph(editFunc, senderID) {
    return await this._editGlyphGuarded(editFunc);
  }

  async editGlyphAndRecordChanges(editFunc, senderID, requireSelectedLayer) {
    return await this._editGlyphGuarded((sendIncrementalChange, subject) => {
      let undoLabel;
      const changes = recordChanges(subject, (subject) => {
        undoLabel = editFunc(subject);
      });
      return { changes, undoLabel };
    });
  }

  async editLayersAndRecordChanges(editFunc, senderID) {
    return await this.editGlyphAndRecordChanges((glyph) => {
      const layerGlyphs = this.getEditingLayerFromGlyphLayers(glyph.layers);
      return editFunc(layerGlyphs);
    }, senderID);
  }

  async _editGlyphGuarded(editFunc) {
    if (this._glyphEditingDonePromise) {
      try {
        await withTimeout(this._glyphEditingDonePromise, 5000);
      } catch (error) {
        throw new Error("can't edit glyph while a previous edit is still running");
      }
    }
    let editingDone;
    this._glyphEditingDonePromise = new Promise((resolve) => {
      editingDone = resolve;
    });
    try {
      return await this._editGlyphUnchecked(editFunc);
    } finally {
      editingDone();
      delete this._glyphEditingDonePromise;
    }
  }

  async _editGlyphUnchecked(editFunc) {
    const sel = this.sceneSettings.selectedGlyph;
    const shape = sel ? this.document.shapeAt(sel.glyphIndex) : undefined;
    if (!shape) {
      return;
    }
    const editSubject = shape.glyphData;
    const sendIncrementalChange = async (change, mayDrop = false) => {
      if (change && hasChange(change)) {
        // The tools already applied the change locally; we just notify.
        this._shapeChanged(shape);
      }
    };
    const initialSelection = this.selection;
    let result;
    try {
      result = await editFunc(sendIncrementalChange, editSubject);
    } catch (error) {
      this.selection = initialSelection;
      throw error;
    }
    const { changes, undoLabel } = result || {};
    if (changes && changes.hasChange) {
      const redoSelection = this.selection;
      this.document.pushUndo({
        label: undoLabel || "edit",
        undo: () => {
          applyChange(editSubject, changes.rollbackChange);
          if (this.document.indexOfShape(shape) >= 0) {
            this.sceneSettings.selectedGlyph = {
              lineIndex: 0,
              glyphIndex: this.document.indexOfShape(shape),
              isEditing: true,
            };
            this.sceneSettings.selection = initialSelection;
          }
          this._shapeChanged(shape);
        },
        redo: () => {
          applyChange(editSubject, changes.change);
          if (this.document.indexOfShape(shape) >= 0) {
            this.sceneSettings.selectedGlyph = {
              lineIndex: 0,
              glyphIndex: this.document.indexOfShape(shape),
              isEditing: true,
            };
            this.sceneSettings.selection = redoSelection;
          }
          this._shapeChanged(shape);
        },
      });
      this._shapeChanged(shape);
    } else {
      this.selection = initialSelection;
    }
  }
}
