// Artboards: named scene rects with a white background and a label.
// The artboard tool (A) drag-creates them; the sidebar panel activates,
// renames and deletes; SVG export crops to the active artboard.
// Artboards live on editor.artboards (not document.shapes) but share the
// document undo stack via pushUndo entries.

export class ArtboardTool {
  identifier = "artboard-tool";

  constructor(editor) {
    this.editor = editor;
    this.canvasController = editor.canvasController;
  }

  activate() {
    this.setCursor();
  }

  deactivate() {
    this._preview = undefined;
  }

  setCursor() {
    this.canvasController.canvas.style.cursor = "crosshair";
  }

  handleHover() {
    this.setCursor();
  }

  async handleDrag(eventStream, initialEvent) {
    const start = this.editor.sceneController.localPoint(initialEvent);
    for await (const event of eventStream) {
      const point = this.editor.sceneController.localPoint(event);
      if (point.x === undefined) {
        continue;
      }
      this._preview = rectFromPoints(start, point);
      this.canvasController.requestUpdate();
    }
    const rect = this._preview;
    this._preview = undefined;
    if (!rect || rect.width < 4 || rect.height < 4) {
      this.canvasController.requestUpdate();
      return;
    }
    addArtboard(this.editor, rect);
  }
}

function rectFromPoints(a, b) {
  const x = Math.round(Math.min(a.x, b.x));
  const y = Math.round(Math.min(a.y, b.y));
  return {
    x,
    y,
    width: Math.max(1, Math.round(Math.abs(a.x - b.x))),
    height: Math.max(1, Math.round(Math.abs(a.y - b.y))),
  };
}

export function addArtboard(editor, rect, name) {
  const artboard = {
    name: name || `Artboard ${editor.artboards.length + 1}`,
    ...rect,
  };
  editor.artboards.push(artboard);
  editor.activeArtboard = artboard;
  editor.document.pushUndo({
    label: "new artboard",
    undo: () => {
      const i = editor.artboards.indexOf(artboard);
      if (i >= 0) {
        editor.artboards.splice(i, 1);
      }
      if (editor.activeArtboard === artboard) {
        editor.activeArtboard = editor.artboards[0];
      }
      editor.canvasController.requestUpdate();
      editor.updateArtboardsPanel?.();
    },
    redo: () => {
      if (!editor.artboards.includes(artboard)) {
        editor.artboards.push(artboard);
      }
      editor.activeArtboard = artboard;
      editor.canvasController.requestUpdate();
      editor.updateArtboardsPanel?.();
    },
  });
  editor.canvasController.requestUpdate();
  editor.updateArtboardsPanel?.();
  return artboard;
}

export function removeArtboard(editor, artboard) {
  const index = editor.artboards.indexOf(artboard);
  if (index < 0) {
    return;
  }
  const wasActive = editor.activeArtboard === artboard;
  editor.artboards.splice(index, 1);
  if (wasActive) {
    editor.activeArtboard = editor.artboards[0];
  }
  editor.document.pushUndo({
    label: "delete artboard",
    undo: () => {
      editor.artboards.splice(Math.min(index, editor.artboards.length), 0, artboard);
      if (wasActive) {
        editor.activeArtboard = artboard;
      }
      editor.canvasController.requestUpdate();
      editor.updateArtboardsPanel?.();
    },
    redo: () => {
      const i = editor.artboards.indexOf(artboard);
      if (i >= 0) {
        editor.artboards.splice(i, 1);
      }
      if (editor.activeArtboard === artboard) {
        editor.activeArtboard = editor.artboards[0];
      }
      editor.canvasController.requestUpdate();
      editor.updateArtboardsPanel?.();
    },
  });
  editor.canvasController.requestUpdate();
  editor.updateArtboardsPanel?.();
}

// Returns true when artboard mode is on (backdrop drawn by caller contract).
export function drawArtboards(editor, context, viewBox) {
  const preview = editor.tools["artboard-tool"]?._preview;
  if (!editor.artboards.length && !preview) {
    context.fillStyle = "#ffffff";
    context.fillRect(
      viewBox.xMin,
      viewBox.yMin,
      viewBox.xMax - viewBox.xMin,
      viewBox.yMax - viewBox.yMin
    );
    return false;
  }
  const onePx = editor.canvasController.onePixelUnit || 1;
  context.fillStyle = "#d5d5db";
  context.fillRect(
    viewBox.xMin,
    viewBox.yMin,
    viewBox.xMax - viewBox.xMin,
    viewBox.yMax - viewBox.yMin
  );
  for (const artboard of editor.artboards) {
    const active = artboard === editor.activeArtboard;
    context.save();
    context.shadowColor = "rgba(0,0,0,0.25)";
    context.shadowBlur = 8 * onePx;
    context.fillStyle = "#ffffff";
    context.fillRect(artboard.x, artboard.y, artboard.width, artboard.height);
    context.restore();
    context.strokeStyle = active ? "#2f6bff" : "#b0b0b8";
    context.lineWidth = (active ? 1.5 : 1) * onePx;
    context.strokeRect(artboard.x, artboard.y, artboard.width, artboard.height);
    drawLabel(editor, context, artboard.name, artboard.x, artboard.y + artboard.height, active);
  }
  if (preview) {
    context.fillStyle = "rgba(255,255,255,0.6)";
    context.fillRect(preview.x, preview.y, preview.width, preview.height);
    context.strokeStyle = "#2f6bff";
    context.lineWidth = onePx;
    context.setLineDash([4 * onePx, 3 * onePx]);
    context.strokeRect(preview.x, preview.y, preview.width, preview.height);
    context.setLineDash([]);
  }
  return true;
}

function drawLabel(editor, context, text, x, topY, active) {
  const onePx = editor.canvasController.onePixelUnit || 1;
  const size = 11 * onePx;
  context.save();
  // The canvas context is y-flipped (scene y-up); un-flip locally for text.
  context.translate(x, topY + 14 * onePx);
  context.scale(1, -1);
  context.font = `${size}px -apple-system, "Segoe UI", sans-serif`;
  context.fillStyle = active ? "#2f6bff" : "#777781";
  context.fillText(text, 0, 0);
  context.restore();
}
