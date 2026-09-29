import { VarPackedPath } from "@fontra/core/var-path.js";

let nextShapeNumber = 1;

export class Shape {
  constructor(name) {
    this.id = Math.random().toString(36).slice(2, 10);
    this.name = name || `Shape ${nextShapeNumber++}`;
    this.x = 0;
    this.y = 0;
    this.fill = "#4a7dff";
    this.stroke = "#1d1d1f";
    this.strokeWidth = 0;
    this.visible = true;
    this.locked = false;
    this.glyphData = {
      name: this.name,
      sources: [],
      layers: {
        main: {
          glyph: {
            path: new VarPackedPath(),
            components: [],
            anchors: [],
            guidelines: [],
            xAdvance: 0,
          },
        },
      },
    };
  }

  get layerGlyph() {
    return this.glyphData.layers.main.glyph;
  }

  get path() {
    return this.layerGlyph.path;
  }
}

export class DocumentModel {
  constructor() {
    this.shapes = [];
    this.undoStack = [];
    this.redoStack = [];
    this._listeners = new Set();
  }

  addListener(listener) {
    this._listeners.add(listener);
  }

  notify() {
    for (const listener of this._listeners) {
      listener();
    }
  }

  addShape(shape, index = undefined) {
    if (index === undefined) {
      this.shapes.push(shape);
    } else {
      this.shapes.splice(index, 0, shape);
    }
    this.notify();
    return this.shapes.indexOf(shape);
  }

  removeShapeAt(index) {
    const [shape] = this.shapes.splice(index, 1);
    this.notify();
    return shape;
  }

  shapeAt(index) {
    return this.shapes[index];
  }

  indexOfShape(shape) {
    return this.shapes.indexOf(shape);
  }

  pushUndo(entry) {
    this.undoStack.push(entry);
    this.redoStack.length = 0;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) {
      return undefined;
    }
    entry.undo();
    this.redoStack.push(entry);
    this.notify();
    return entry;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) {
      return undefined;
    }
    entry.redo();
    this.undoStack.push(entry);
    this.notify();
    return entry;
  }
}
