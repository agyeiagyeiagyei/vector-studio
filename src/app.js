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
import { BaseTool } from "../vendor/fontra/tools/edit-tools-base.js";

import { DocumentModel, Shape } from "./document.js";
import {
  defaultGradient,
  fillToCSS,
  isGradient,
  sortedStops,
} from "./gradients.js";
import { SceneController } from "./scene.js";
import {
  DEFAULT_FONT_ID,
  FontManager,
  relayoutTextShape,
  textShapeToOutlines,
} from "./text.js";

class TextTool extends BaseTool {
  identifier = "text-tool";

  handleHover(event) {
    this.setCursor();
  }

  setCursor() {
    this.canvasController.canvas.style.cursor = "text";
  }

  async handleDrag(eventStream, initialEvent) {
    const point = this.sceneController.localPoint(initialEvent);
    const hit = this.sceneModel.glyphAtPoint(point);
    if (hit) {
      this.sceneSettings.selectedGlyph = hit;
      this.editor.canvasController.requestUpdate();
    } else {
      await this.editor.createTextShapeAt(point);
    }
    eventStream.done();
  }
}
import { VisualizationLayers, makeVisContext } from "./visualization.js";
import { exportSVG, importSVG } from "./svg.js";
import { ThreeDView } from "./threed.js";
import { CurvaturePenTool } from "./curvature.js";

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
      TextTool,
      CurvaturePenTool,
    ]) {
      const tool = new ToolClass(this);
      this.tools[tool.identifier] = tool;
    }

    this.fonts = new FontManager();
    this.fonts.ensureDefaultFont().catch((error) => {
      console.error("default font failed to load", error);
    });

    // Text shapes edit via the text panel, never node editing: clamp isEditing
    this.sceneSettings.guardSelectedGlyph = (sel) => {
      const shape = sel ? this.document.shapeAt(sel.glyphIndex) : undefined;
      if (sel?.isEditing && shape?.text) {
        queueMicrotask(() => {
          this.updateTextPanel();
          const textarea = document.getElementById("text-content");
          textarea.focus();
          textarea.select();
        });
        return { ...sel, isEditing: false };
      }
      return sel;
    };

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

  async createTextShapeAt(point) {
    try {
      await this.fonts.ensureDefaultFont();
    } catch (error) {
      return;
    }
    const shape = new Shape("Text");
    shape.text = {
      string: "Text",
      font: DEFAULT_FONT_ID,
      size: 96,
      variations: {},
    };
    relayoutTextShape(this.fonts, shape);
    shape.x = Math.round(point.x);
    shape.y = Math.round(point.y);
    const index = this.document.addShape(shape);
    this.sceneSettings.selectedGlyph = { lineIndex: 0, glyphIndex: index, isEditing: false };
    this.sceneSettings.selection = new Set();
    this.document.pushUndo({
      label: "new text",
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
          isEditing: false,
        };
        this.canvasController.requestUpdate();
      },
    });
    this.setSelectedTool("pointer-tool");
    this.canvasController.requestUpdate();
    this.updateStylePanel();
    this.updateTextPanel();
    document.getElementById("text-content").focus();
    document.getElementById("text-content").select();
    return shape;
  }

  convertTextToOutlines() {
    const sel = this.sceneSettings.selectedGlyph;
    const shape = sel ? this.document.shapeAt(sel.glyphIndex) : undefined;
    if (!shape?.text) {
      return;
    }
    const letters = textShapeToOutlines(this.fonts, shape, Shape);
    if (!letters.length) {
      return;
    }
    const index = this.document.indexOfShape(shape);
    this.sceneSettings.selectedGlyph = undefined;
    this.document.removeShapeAt(index);
    for (const letter of letters) {
      this.document.addShape(letter);
    }
    this.document.pushUndo({
      label: "convert to outlines",
      undo: () => {
        for (const letter of letters) {
          this.document.removeShapeAt(this.document.indexOfShape(letter));
        }
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
        for (const letter of letters) {
          this.document.addShape(letter);
        }
        this.canvasController.requestUpdate();
      },
    });
    this.sceneSettings.selectedGlyph = {
      lineIndex: 0,
      glyphIndex: this.document.indexOfShape(letters[0]),
      isEditing: false,
    };
    this.sceneSettings.selection = new Set();
    this.canvasController.requestUpdate();
    this.updateLayersPanel();
    this.updateStylePanel();
    this.updateTextPanel();
  }

  updateTextPanel() {
    const shape = this.styleShape;
    const panel = document.getElementById("text-panel");
    const isText = !!shape?.text;
    panel.style.display = isText ? "block" : "none";
    if (!isText) {
      this._textShape = undefined;
      return;
    }
    const rebuilt = this._textShape !== shape || this._textFont !== shape.text.font;
    this._textShape = shape;
    this._textFont = shape.text.font;
    if (!rebuilt) {
      return;
    }
    document.getElementById("text-content").value = shape.text.string;
    document.getElementById("text-size").value = shape.text.size;

    const fontSelect = document.getElementById("font-select");
    fontSelect.innerHTML = "";
    for (const font of this.fonts.fonts.values()) {
      const option = document.createElement("option");
      option.value = font.id;
      option.textContent = font.name;
      fontSelect.appendChild(option);
    }
    fontSelect.value = shape.text.font;

    const axesContainer = document.getElementById("axes-container");
    axesContainer.innerHTML = "";
    const entry = this.fonts.get(shape.text.font);
    for (const axis of entry?.axes || []) {
      const value = shape.text.variations[axis.tag] ?? axis.default;
      const label = document.createElement("label");
      label.className = "axis-row";
      const name = document.createElement("span");
      name.className = "axis-tag";
      name.textContent = axis.tag;
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = axis.min;
      slider.max = axis.max;
      slider.step = Math.max(1, (axis.max - axis.min) / 200);
      slider.value = value;
      const readout = document.createElement("span");
      readout.className = "axis-value";
      readout.textContent = value;
      slider.addEventListener("input", () => {
        shape.text.variations[axis.tag] = parseFloat(slider.value);
        readout.textContent = slider.value;
        relayoutTextShape(this.fonts, shape);
        this.sceneController._shapeChanged(shape);
      });
      label.appendChild(name);
      label.appendChild(slider);
      label.appendChild(readout);
      axesContainer.appendChild(label);
    }
  }

  applyTextFromPanel() {
    const shape = this.styleShape;
    if (!shape?.text) {
      return;
    }
    shape.text.string = document.getElementById("text-content").value;
    shape.text.size =
      Math.max(4, parseFloat(document.getElementById("text-size").value)) || 96;
    shape.text.font = document.getElementById("font-select").value;
    relayoutTextShape(this.fonts, shape);
    this.sceneController._shapeChanged(shape);
  }

  openThreeD() {
    if (this._threed) {
      return;
    }
    const sel = this.sceneSettings.selectedGlyph;
    let shapes = [];
    if (sel) {
      const s = this.document.shapeAt(sel.glyphIndex);
      if (s) {
        shapes = [s];
      }
    } else {
      shapes = this.document.shapes.filter((s) => s.visible && s.path.numPoints > 0);
    }
    if (!shapes.length) {
      return;
    }
    document.getElementById("threed-overlay").style.display = "flex";
    this._threed = new ThreeDView(document.getElementById("threed-canvas-wrap"), shapes);
  }

  closeThreeD() {
    if (!this._threed) {
      return;
    }
    this._threed.dispose();
    this._threed = undefined;
    document.getElementById("threed-overlay").style.display = "none";
    this.canvasController.requestUpdate();
  }

  exportThreeDPNG() {
    if (!this._threed) {
      return;
    }
    const dataUrl = this._threed.renderPNG();
    window._lastPng = dataUrl; // for tests
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "vector-studio-3d.png";
    a.click();
  }

  flattenThreeD() {
    if (!this._threed) {
      return;
    }
    const svg = this._threed.renderSVG();
    const imported = importSVG(this.document, svg, Shape);
    for (const shape of imported) {
      this.document.pushUndo({
        label: "flatten 3d",
        undo: () => {
          this.sceneSettings.selectedGlyph = undefined;
          this.document.removeShapeAt(this.document.indexOfShape(shape));
          this.canvasController.requestUpdate();
        },
        redo: () => {
          this.document.addShape(shape);
          this.canvasController.requestUpdate();
        },
      });
    }
    this.canvasController.requestUpdate();
    this.updateLayersPanel();
    return imported.length;
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
    if (event[commandKeyProperty] && event.key.toLowerCase() === "a") {
      const sel = this.sceneSettings.selectedGlyph;
      const shape = sel ? this.document.shapeAt(sel.glyphIndex) : undefined;
      if (sel?.isEditing && shape) {
        event.preventDefault();
        const all = new Set();
        for (let i = 0; i < shape.path.numPoints; i++) {
          all.add(`point/${i}`);
        }
        this.sceneSettings.selection = all;
        this.canvasController.requestUpdate();
      }
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (this.selectedTool.handleDelete?.()) {
        return;
      }
      this.deleteSelection();
      return;
    }
    if (event.key === "Escape") {
      if (this._threed) {
        this.closeThreeD();
        return;
      }
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
      c: "pen-tool-curvature",
      k: "knife-tool",
      r: "shape-tool-rectangle",
      o: "shape-tool-ellipse",
      t: "text-tool",
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

for (const id of ["text-content", "text-size"]) {
  document.getElementById(id).addEventListener("input", () => editor.applyTextFromPanel());
}
document.getElementById("font-select").addEventListener("change", () => {
  editor.applyTextFromPanel();
  editor._textFont = undefined; // force axes rebuild for the new font
  editor.updateTextPanel();
});
document.getElementById("font-upload-btn").addEventListener("click", () => {
  document.getElementById("font-upload").click();
});
document.getElementById("font-upload").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) {
    return;
  }
  const id = "user-" + file.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  try {
    editor.fonts.loadFromBuffer(
      await file.arrayBuffer(),
      id,
      file.name.replace(/\.[^.]+$/, "")
    );
  } catch (error) {
    console.error("font load failed", error);
    return;
  }
  event.target.value = "";
  const shape = editor.styleShape;
  if (shape?.text) {
    shape.text.font = id;
    shape.text.variations = {};
    relayoutTextShape(editor.fonts, shape);
    editor.sceneController._shapeChanged(shape);
  }
  editor._textShape = undefined; // force panel rebuild to list the new font
  editor.updateTextPanel();
});
document.getElementById("convert-outlines").addEventListener("click", () => {
  editor.convertTextToOutlines();
});
document.getElementById("threed-open").addEventListener("click", () => editor.openThreeD());
document.getElementById("threed-close").addEventListener("click", () => editor.closeThreeD());
document.getElementById("threed-export-png").addEventListener("click", () => editor.exportThreeDPNG());
document.getElementById("threed-flatten").addEventListener("click", () => editor.flattenThreeD());
document.getElementById("threed-depth").addEventListener("input", (e) => {
  if (editor._threed) {
    editor._threed.depth = parseFloat(e.target.value);
    editor._threed.rebuild();
  }
});
document.getElementById("threed-material").addEventListener("change", (e) => {
  if (editor._threed) {
    editor._threed.materialType = e.target.value;
    editor._threed.rebuild();
  }
});
for (const id of ["threed-azimuth", "threed-elevation"]) {
  document.getElementById(id).addEventListener("input", () => {
    if (editor._threed) {
      editor._threed.setLight(
        parseFloat(document.getElementById("threed-azimuth").value),
        parseFloat(document.getElementById("threed-elevation").value)
      );
    }
  });
}

// Watch selection changes to update panels: poll cheaply on mouseup/keyup
canvas.addEventListener("mouseup", () => {
  editor.updateLayersPanel();
  editor.updateStylePanel();
  editor.updateTextPanel();
});
window.addEventListener("keyup", () => {
  editor.updateLayersPanel();
  editor.updateStylePanel();
  editor.updateTextPanel();
});

editor.updateLayersPanel();
editor.canvasController.requestUpdate();
