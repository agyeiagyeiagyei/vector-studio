import { CanvasController } from "@fontra/core/canvas-controller.js";
import { MouseTracker } from "@fontra/core/mouse-tracker.js";
import { deleteSelectedPoints } from "@fontra/core/path-functions.js";
import { SceneView } from "@fontra/core/scene-view.js";
import { commandKeyProperty, parseSelection } from "@fontra/core/utils.ts";

import { KnifeTool } from "../vendor/fontra/tools/edit-tools-knife.js";
import { PenToolCubic } from "../vendor/fontra/tools/edit-tools-pen.js";
import { PointerTool } from "../vendor/fontra/tools/edit-tools-pointer.js";
import {
  ShapeToolEllipse,
  ShapeToolRect,
} from "../vendor/fontra/tools/edit-tools-shape.js";
import { HandTool } from "../vendor/fontra/tools/edit-tools-hand.js";

import { DocumentModel, Shape } from "./document.js";
import {
  defaultGradient,
  fillToCSS,
  isGradient,
  sortedStops,
} from "./gradients.js";
import { SceneController } from "./scene.js";
import { VisualizationLayers, makeVisContext } from "./visualization.js";
import { exportSVG, importSVG } from "./svg.js";

class EditorShell {
  constructor(canvas) {
    this.document = new DocumentModel();
    this.canvasController = new CanvasController(canvas);
    this.sceneController = new SceneController(this.document, this.canvasController);
    this.sceneModel = this.sceneController.sceneModel;
    this.sceneSettingsController = { model: this.sceneController.sceneSettings };
    this.sceneSettings = this.sceneController.sceneSettings;
    this.fontController = {
      getBackgroundImageBoundsFunc: undefined,
      readOnly: false,
    };
    this.visualizationLayers = new VisualizationLayers(false);
    this.visualizationLayers.scaleFactor = this.canvasController.onePixelUnit;
    this.visualizationLayersSettings = {
      model: { "fontra.transform.selection": true },
    };

    this.tools = {};
    for (const ToolClass of [
      PointerTool,
      PenToolCubic,
      KnifeTool,
      ShapeToolRect,
      ShapeToolEllipse,
      HandTool,
    ]) {
      const tool = new ToolClass(this);
      this.tools[tool.identifier] = tool;
    }

    // Pen and shape tools auto-create a shape when none is being edited
    for (const id of ["pen-tool-cubic", "shape-tool-rectangle", "shape-tool-ellipse"]) {
      const tool = this.tools[id];
      const originalHandleDrag = tool.handleDrag.bind(tool);
      tool.handleDrag = async (eventStream, initialEvent) => {
        if (!this.sceneModel.selectedGlyph?.isEditing) {
          this.createShapeAndEnterEditing();
        }
        return await originalHandleDrag(eventStream, initialEvent);
      };
    }

    this.canvasController.sceneView = new SceneView(this.sceneModel, (model, controller) =>
      this.drawScene(model, controller)
    );

    this.mouseTracker = new MouseTracker({
      element: canvas,
      drag: async (eventStream, initialEvent) => {
        try {
          if (this._spaceDown) {
            await this.tools["hand-tool"].handleDrag(eventStream, initialEvent);
          } else {
            await this.selectedTool.handleDrag(eventStream, initialEvent);
          }
        } catch (error) {
          console.error("drag error", error);
        }
      },
      hover: (event) => {
        if (event.pageX === undefined) {
          // key events reach hover via MouseTracker; nothing to do without coords
          return;
        }
        try {
          this.selectedTool.handleHover(event);
        } catch (error) {
          console.error("hover error", error);
        }
      },
    });

    this.selectedTool = this.tools["pointer-tool"];
    this.selectedTool.activate();

    canvas.addEventListener("viewBoxChanged", () => {
      this.visualizationLayers.scaleFactor = this.canvasController.onePixelUnit;
    });

    this.document.addListener(() => this.updateLayersPanel());

    window.addEventListener("keydown", (event) => this.handleKeyDown(event));
    window.addEventListener("keyup", (event) => {
      if (event.key === " ") {
        this._spaceDown = false;
        this.selectedTool.setCursor();
      }
    });
  }

  drawScene(model, controller) {
    const context = controller.context;
    const viewBox = controller.getViewBox();
    context.fillStyle = "#ffffff";
    context.fillRect(
      viewBox.xMin,
      viewBox.yMin,
      viewBox.xMax - viewBox.xMin,
      viewBox.yMax - viewBox.yMin
    );
    this.visualizationLayers.drawVisualizationLayers(makeVisContext(model, controller));
  }

  getPenTool() {
    return this.tools["pen-tool-cubic"];
  }

  setSelectedTool(identifier) {
    if (this.selectedTool) {
      this.selectedTool.deactivate();
    }
    this.selectedTool = this.tools[identifier];
    this.selectedTool.activate();
    document.querySelectorAll("#toolbar button[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === identifier);
    });
  }

  createShapeAndEnterEditing() {
    const shape = new Shape();
    const index = this.document.addShape(shape);
    this.sceneSettings.selectedGlyph = { lineIndex: 0, glyphIndex: index, isEditing: true };
    this.sceneSettings.selection = new Set();
    this.document.pushUndo({
      label: "new shape",
      undo: () => {
        this.sceneSettings.selectedGlyph = undefined;
        this.document.removeShapeAt(this.document.indexOfShape(shape));
        this.canvasController.requestUpdate();
      },
      redo: () => {
        const newIndex = this.document.addShape(shape);
        this.sceneSettings.selectedGlyph = {
          lineIndex: 0,
          glyphIndex: newIndex,
          isEditing: true,
        };
        this.canvasController.requestUpdate();
      },
    });
    this.canvasController.requestUpdate();
    return shape;
  }

  // Called by the (patched) pointer tool for click-drag on a shape while not editing
  async moveGlyphDrag(glyphSelection, eventStream, initialEvent) {
    const shape = this.document.shapeAt(glyphSelection.glyphIndex);
    if (!shape || shape.locked) {
      eventStream.done();
      return;
    }
    const initialPoint = this.sceneController.localPoint(initialEvent);
    const initialX = shape.x;
    const initialY = shape.y;
    let moved = false;
    for await (const event of eventStream) {
      const point = this.sceneController.localPoint(event);
      if (point.x === undefined) {
        continue;
      }
      shape.x = initialX + Math.round(point.x - initialPoint.x);
      shape.y = initialY + Math.round(point.y - initialPoint.y);
      moved = true;
      this.sceneController._shapeChanged(shape);
    }
    if (moved && (shape.x !== initialX || shape.y !== initialY)) {
      const finalX = shape.x;
      const finalY = shape.y;
      this.document.pushUndo({
        label: "move shape",
        undo: () => {
          shape.x = initialX;
          shape.y = initialY;
          this.sceneController._shapeChanged(shape);
        },
        redo: () => {
          shape.x = finalX;
          shape.y = finalY;
          this.sceneController._shapeChanged(shape);
        },
      });
    }
  }

  async deleteSelection() {
    const sel = this.sceneSettings.selectedGlyph;
    if (sel?.isEditing) {
      const { point: pointIndices } = parseSelection(this.sceneSettings.selection);
      if (!pointIndices?.length) {
        return;
      }
      await this.sceneController.editLayersAndRecordChanges((layerGlyphs) => {
        for (const layerGlyph of Object.values(layerGlyphs)) {
          deleteSelectedPoints(layerGlyph.path, pointIndices);
        }
        this.sceneController.selection = new Set();
        return "delete points";
      });
    } else if (sel) {
      const shape = this.document.shapeAt(sel.glyphIndex);
      if (!shape) {
        return;
      }
      const index = sel.glyphIndex;
      this.sceneSettings.selectedGlyph = undefined;
      this.document.removeShapeAt(index);
      this.document.pushUndo({
        label: "delete shape",
        undo: () => {
          const newIndex = this.document.addShape(shape, Math.min(index, this.document.shapes.length));
          this.sceneSettings.selectedGlyph = {
            lineIndex: 0,
            glyphIndex: newIndex,
            isEditing: false,
          };
          this.canvasController.requestUpdate();
        },
        redo: () => {
          this.sceneSettings.selectedGlyph = undefined;
          this.document.removeShapeAt(this.document.indexOfShape(shape));
          this.canvasController.requestUpdate();
        },
      });
      this.canvasController.requestUpdate();
    }
  }

  handleKeyDown(event) {
    if (event.target.matches("input, textarea, select")) {
      return;
    }
    if (event.key === " ") {
      this._spaceDown = true;
      this.canvasController.canvas.style.cursor = "grab";
      event.preventDefault();
      return;
    }
    if (event[commandKeyProperty] && event.key.toLowerCase() === "z") {
      event.preventDefault();
      const entry = event.shiftKey ? this.document.redo() : this.document.undo();
      if (entry) {
        this.canvasController.requestUpdate();
        this.updateLayersPanel();
      }
      return;
    }
    if (event[commandKeyProperty] && event.key.toLowerCase() === "y") {
      event.preventDefault();
      if (this.document.redo()) {
        this.canvasController.requestUpdate();
        this.updateLayersPanel();
      }
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.deleteSelection();
      return;
    }
    if (event.key === "Escape") {
      if (this.sceneSettings.selectedGlyph?.isEditing) {
        this.sceneSettings.selectedGlyph = {
          ...this.sceneSettings.selectedGlyph,
          isEditing: false,
        };
        this.sceneSettings.selection = new Set();
        this.canvasController.requestUpdate();
      }
      return;
    }
    const toolKeys = {
      v: "pointer-tool",
      p: "pen-tool-cubic",
      k: "knife-tool",
      r: "shape-tool-rectangle",
      o: "shape-tool-ellipse",
      h: "hand-tool",
    };
    if (!event[commandKeyProperty] && !event.altKey && toolKeys[event.key.toLowerCase()]) {
      this.setSelectedTool(toolKeys[event.key.toLowerCase()]);
      return;
    }
    if (this.selectedTool.handleKeyDown) {
      this.selectedTool.handleKeyDown(event);
    }
  }

  updateLayersPanel() {
    const list = document.getElementById("layers-list");
    list.innerHTML = "";
    const selectedIndex = this.sceneSettings.selectedGlyph?.glyphIndex;
    this.document.shapes.forEach((shape, index) => {
      const item = document.createElement("div");
      item.className = "layer-item";
      if (index === selectedIndex) {
        item.classList.add("selected");
      }
      const swatch = document.createElement("span");
      swatch.className = "layer-swatch";
      swatch.style.background = fillToCSS(shape.fill);
      const name = document.createElement("span");
      name.className = "layer-name";
      name.textContent = shape.name;
      item.appendChild(swatch);
      item.appendChild(name);
      item.addEventListener("click", () => {
        this.sceneSettings.selectedGlyph = {
          lineIndex: 0,
          glyphIndex: index,
          isEditing: false,
        };
        this.sceneSettings.selection = new Set();
        this.canvasController.requestUpdate();
        this.updateLayersPanel();
        this.updateStylePanel();
      });
      item.addEventListener("dblclick", () => {
        this.sceneSettings.selectedGlyph = {
          lineIndex: 0,
          glyphIndex: index,
          isEditing: true,
        };
        this.sceneSettings.selection = new Set();
        this.canvasController.requestUpdate();
        this.updateLayersPanel();
      });
      list.appendChild(item);
    });
  }

  updateStylePanel() {
    const sel = this.sceneSettings.selectedGlyph;
    const shape = sel ? this.document.shapeAt(sel.glyphIndex) : undefined;
    const panel = document.getElementById("style-panel");
    panel.style.display = shape ? "block" : "none";
    if (!shape) {
      this._styleShape = undefined;
      return;
    }
    if (this._styleShape !== shape) {
      this._styleShape = shape;
      this._stopIndex = 0;
    }
    const fill = shape.fill;
    const fillType = fill == null ? "none" : isGradient(fill) ? fill.type : "solid";
    document.getElementById("fill-type").value = fillType;
    document.getElementById("fill-solid-row").style.display =
      fillType === "solid" ? "flex" : "none";
    document.getElementById("gradient-editor").style.display = isGradient(fill)
      ? "block"
      : "none";
    if (fillType === "solid") {
      document.getElementById("fill-color").value = normalizeColor(fill) || "#4a7dff";
    }
    if (isGradient(fill)) {
      this._renderGradientEditor(shape);
    }
    document.getElementById("stroke-color").value =
      normalizeColor(shape.stroke) || "#1d1d1f";
    document.getElementById("stroke-width").value = shape.strokeWidth || 0;
  }

  _renderGradientEditor(shape) {
    const fill = shape.fill;
    const bar = document.getElementById("gradient-bar");
    bar.style.background = fillToCSS(fill);
    const angleRow = document.getElementById("gradient-angle-row");
    const radiusRow = document.getElementById("gradient-radius-row");
    angleRow.style.display = fill.type === "linear" ? "flex" : "none";
    radiusRow.style.display = fill.type === "radial" ? "flex" : "none";
    if (fill.type === "linear") {
      const angle = Math.round(fill.angle ?? 0);
      document.getElementById("gradient-angle").value = angle;
      document.getElementById("gradient-angle-value").textContent = `${angle}°`;
    } else {
      const radius = Math.round((fill.r ?? 0.5) * 100);
      document.getElementById("gradient-radius").value = radius;
      document.getElementById("gradient-radius-value").textContent = `${radius}%`;
    }
    const stops = sortedStops(fill);
    this._stopIndex = Math.min(this._stopIndex ?? 0, stops.length - 1);
    const selected = stops[this._stopIndex];
    document.getElementById("stop-color").value =
      normalizeColor(selected.color) || "#ffffff";
    document.getElementById("stop-offset").value = Math.round(selected.offset * 100);
    document.getElementById("stop-delete").disabled = stops.length <= 2;

    bar.querySelectorAll(".gradient-stop").forEach((el) => el.remove());
    stops.forEach((stop, i) => {
      const dot = document.createElement("div");
      dot.className = "gradient-stop" + (i === this._stopIndex ? " selected" : "");
      dot.style.left = `${stop.offset * 100}%`;
      dot.style.background = stop.color;
      dot.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._stopIndex = i;
        this._dragGradientStop(event, bar, shape, dot, stop);
      });
      bar.appendChild(dot);
    });
  }

  _dragGradientStop(event, bar, shape, dot, stop) {
    const rect = bar.getBoundingClientRect();
    const move = (e) => {
      stop.offset = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      dot.style.left = `${stop.offset * 100}%`;
      bar.style.background = fillToCSS(shape.fill);
      this.canvasController.requestUpdate();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.updateStylePanel();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    this.updateStylePanel();
  }

  addGradientStop(clientX) {
    const shape = this.styleShape;
    if (!shape || !isGradient(shape.fill)) {
      return;
    }
    const bar = document.getElementById("gradient-bar");
    const rect = bar.getBoundingClientRect();
    const offset = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const stops = sortedStops(shape.fill);
    let nearest = stops[0];
    for (const stop of stops) {
      if (Math.abs(stop.offset - offset) < Math.abs(nearest.offset - offset)) {
        nearest = stop;
      }
    }
    const newStop = { offset, color: nearest?.color || "#ffffff" };
    shape.fill.stops.push(newStop);
    this._stopIndex = sortedStops(shape.fill).indexOf(newStop);
    this.canvasController.requestUpdate();
    this.updateLayersPanel();
    this.updateStylePanel();
  }

  deleteSelectedStop() {
    const shape = this.styleShape;
    if (!shape || !isGradient(shape.fill) || shape.fill.stops.length <= 2) {
      return;
    }
    const stops = sortedStops(shape.fill);
    const selected = stops[Math.min(this._stopIndex ?? 0, stops.length - 1)];
    shape.fill.stops.splice(shape.fill.stops.indexOf(selected), 1);
    this._stopIndex = 0;
    this.canvasController.requestUpdate();
    this.updateLayersPanel();
    this.updateStylePanel();
  }

  get styleShape() {
    const sel = this.sceneSettings.selectedGlyph;
    return sel ? this.document.shapeAt(sel.glyphIndex) : undefined;
  }

  setFillType(type) {
    const shape = this.styleShape;
    if (!shape) {
      return;
    }
    const fill = shape.fill;
    if (type === "none") {
      shape.fill = null;
    } else if (type === "solid") {
      shape.fill = isGradient(fill)
        ? sortedStops(fill)[0]?.color || "#4a7dff"
        : fill || "#4a7dff";
    } else if (isGradient(fill) && fill.type === type) {
      // already that gradient type; keep as-is
    } else {
      const fromColor = isGradient(fill)
        ? sortedStops(fill)[0]?.color
        : typeof fill === "string"
          ? fill
          : undefined;
      const stops = isGradient(fill) ? fill.stops : undefined;
      shape.fill = defaultGradient(type, fromColor);
      if (stops?.length >= 2) {
        shape.fill.stops = stops;
      }
    }
    this._stopIndex = 0;
    this.canvasController.requestUpdate();
    this.updateLayersPanel();
    this.updateStylePanel();
  }

  applyStyleFromPanel() {
    const shape = this.styleShape;
    if (!shape) {
      return;
    }
    const fillType = document.getElementById("fill-type").value;
    if (fillType === "none") {
      shape.fill = null;
    } else if (fillType === "solid") {
      shape.fill = document.getElementById("fill-color").value;
    } else {
      let fill = shape.fill;
      if (!isGradient(fill) || fill.type !== fillType) {
        return this.setFillType(fillType);
      }
      const stops = sortedStops(fill);
      const selected = stops[Math.min(this._stopIndex ?? 0, stops.length - 1)];
      if (selected) {
        selected.color = document.getElementById("stop-color").value;
        selected.offset = Math.min(
          1,
          Math.max(0, (parseFloat(document.getElementById("stop-offset").value) || 0) / 100)
        );
      }
      if (fill.type === "linear") {
        fill.angle = parseFloat(document.getElementById("gradient-angle").value) || 0;
        document.getElementById("gradient-angle-value").textContent =
          `${Math.round(fill.angle)}°`;
      } else {
        fill.r = (parseFloat(document.getElementById("gradient-radius").value) || 50) / 100;
        document.getElementById("gradient-radius-value").textContent =
          `${Math.round(fill.r * 100)}%`;
      }
      document.getElementById("gradient-bar").style.background = fillToCSS(fill);
    }
    shape.stroke = document.getElementById("stroke-color").value;
    shape.strokeWidth = parseFloat(document.getElementById("stroke-width").value) || 0;
    this.canvasController.requestUpdate();
    this.updateLayersPanel();
  }

  zoomToFit() {
    let bounds;
    for (const shape of this.document.shapes) {
      const b = shape.path.getControlBounds();
      if (!b) {
        continue;
      }
      const sb = {
        xMin: b.xMin + shape.x,
        yMin: b.yMin + shape.y,
        xMax: b.xMax + shape.x,
        yMax: b.yMax + shape.y,
      };
      bounds = bounds
        ? {
            xMin: Math.min(bounds.xMin, sb.xMin),
            yMin: Math.min(bounds.yMin, sb.yMin),
            xMax: Math.max(bounds.xMax, sb.xMax),
            yMax: Math.max(bounds.yMax, sb.yMax),
          }
        : sb;
    }
    if (!bounds) {
      return;
    }
    const margin = 40;
    this.canvasController.setViewBox({
      xMin: bounds.xMin - margin,
      yMin: bounds.yMin - margin,
      xMax: bounds.xMax + margin,
      yMax: bounds.yMax + margin,
    });
  }
}

function normalizeColor(color) {
  if (!color) {
    return null;
  }
  if (color.startsWith("#") && color.length === 7) {
    return color;
  }
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = color;
  const computed = ctx.fillStyle;
  if (computed.startsWith("#")) {
    return computed;
  }
  const m = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    return (
      "#" +
      [m[1], m[2], m[3]].map((v) => parseInt(v).toString(16).padStart(2, "0")).join("")
    );
  }
  return null;
}

// --- Bootstrap ---

const canvas = document.getElementById("canvas");
const editor = new EditorShell(canvas);
window._editor = editor; // for tests
window._exportSVG = () => exportSVG(editor.document); // for tests

document.querySelectorAll("#toolbar button[data-tool]").forEach((button) => {
  button.addEventListener("click", () => editor.setSelectedTool(button.dataset.tool));
});

document.getElementById("undo-button").addEventListener("click", () => {
  if (editor.document.undo()) {
    editor.canvasController.requestUpdate();
    editor.updateLayersPanel();
  }
});
document.getElementById("redo-button").addEventListener("click", () => {
  if (editor.document.redo()) {
    editor.canvasController.requestUpdate();
    editor.updateLayersPanel();
  }
});
document.getElementById("zoom-fit").addEventListener("click", () => editor.zoomToFit());

document.getElementById("export-svg").addEventListener("click", () => {
  const svg = exportSVG(editor.document);
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vector-studio.svg";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("import-svg").addEventListener("click", () => {
  document.getElementById("import-file").click();
});
document.getElementById("import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) {
    return;
  }
  const text = await file.text();
  const imported = importSVG(editor.document, text, Shape);
  for (const shape of imported) {
    editor.document.pushUndo({
      label: "import svg",
      undo: () => {
        editor.sceneSettings.selectedGlyph = undefined;
        editor.document.removeShapeAt(editor.document.indexOfShape(shape));
        editor.canvasController.requestUpdate();
      },
      redo: () => {
        editor.document.addShape(shape);
        editor.canvasController.requestUpdate();
      },
    });
  }
  event.target.value = "";
  editor.canvasController.requestUpdate();
  editor.updateLayersPanel();
});

for (const id of [
  "fill-color",
  "stroke-color",
  "stroke-width",
  "stop-color",
  "stop-offset",
  "gradient-angle",
  "gradient-radius",
]) {
  document.getElementById(id).addEventListener("input", () => editor.applyStyleFromPanel());
}
document
  .getElementById("fill-type")
  .addEventListener("change", (e) => editor.setFillType(e.target.value));
document
  .getElementById("stop-delete")
  .addEventListener("click", () => editor.deleteSelectedStop());
document.getElementById("gradient-bar").addEventListener("pointerdown", (e) => {
  if (e.target.id === "gradient-bar") {
    editor.addGradientStop(e.clientX);
  }
});

// Watch selection changes to update panels: poll cheaply on mouseup/keyup
canvas.addEventListener("mouseup", () => {
  editor.updateLayersPanel();
  editor.updateStylePanel();
});
window.addEventListener("keyup", () => {
  editor.updateLayersPanel();
  editor.updateStylePanel();
});

editor.updateLayersPanel();
editor.canvasController.requestUpdate();
