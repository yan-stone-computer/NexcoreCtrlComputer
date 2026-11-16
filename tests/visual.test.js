import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { ActionPolicy, Computer } from "../src/index.js";
import {
  createVisualFrame,
  imageDimensions,
  normalizeVisualGrid,
  resolveVisualRegion,
  resolveVisualPoint,
  resolveVisualZoomPoint,
  visualFrameExpired
} from "../src/visual.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("visual frames map grid cells to display coordinates", () => {
  const frame = createVisualFrame({
    bytes: PNG_1X1,
    imagePath: "frame.png",
    display: {
      id: "monitor-1",
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      scale: 1.5,
      is_primary: false
    },
    activeWindow: { id: 7, title: "Calculator", bounds: { x: 10, y: 20, width: 300, height: 400 } },
    grid: { columns: 4, rows: 2 },
    createdAt: 1000,
    ttlMs: 30000
  });
  assert.equal(frame.width, 1);
  assert.equal(frame.height, 1);
  assert.equal(frame.grid.cellWidth, 0.25);
  assert.equal(frame.grid.cellHeight, 0.5);

  const point = resolveVisualPoint(frame, { cell: "C2", at: { x: 0.5, y: 0.5 } });
  assert.deepEqual(point.normalized, { x: 0.625, y: 0.75 });
  assert.deepEqual(point.imagePoint, { x: 1, y: 1 });
  assert.deepEqual(point.screenPoint, { x: -720, y: 810 });
  assert.equal(point.strategy, "visual-cell:C2");
});

test("window visual frames map points to the window instead of the full display", () => {
  const frame = createVisualFrame({
    bytes: PNG_1X1,
    imagePath: "frame.png",
    display: { id: "monitor-1", bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
    capture: {
      kind: "window",
      windowId: "w-1",
      bounds: { x: 600, y: 200, width: 1000, height: 800 }
    },
    grid: { columns: 8, rows: 6 }
  });
  frame.width = 800;
  frame.height = 600;

  const point = resolveVisualPoint(frame, { normalized: { x: 0.5, y: 0.25 } });
  assert.deepEqual(point.screenPoint, { x: 1100, y: 400 });
  assert.equal(frame.capture.kind, "window");
});

test("visual frame validation rejects unsupported grids and reports expiry", () => {
  assert.deepEqual(normalizeVisualGrid(), { columns: 8, rows: 6 });
  assert.throws(() => normalizeVisualGrid({ columns: 1, rows: 6 }), /columns/);
  const dimensions = imageDimensions(PNG_1X1);
  assert.deepEqual(dimensions, { width: 1, height: 1, mimeType: "image/png" });
  assert.equal(visualFrameExpired({ expiresAt: 99 }, 100), true);
  assert.equal(visualFrameExpired({ expiresAt: 101 }, 100), false);
});

test("visual candidates and zoom regions map back to the parent frame", () => {
  const frame = createVisualFrame({
    bytes: PNG_1X1,
    imagePath: "frame.png",
    display: { id: "monitor-1", bounds: { x: 100, y: 50, width: 2000, height: 1000 } },
    grid: { columns: 8, rows: 6 }
  });
  frame.width = 2000;
  frame.height = 1000;
  frame.candidates = [{
    id: "v3",
    role: "button",
    name: "Save",
    bounds: { x: 500, y: 250, width: 200, height: 100 },
    normalized: { x: 0.3, y: 0.3 }
  }];
  const candidate = resolveVisualPoint(frame, { candidateId: "v3" });
  assert.deepEqual(candidate.screenPoint, { x: 700, y: 350 });
  const candidateRegion = resolveVisualRegion(frame, { candidateId: "v3" });
  assert.deepEqual(candidateRegion.normalized, { x: 0.25, y: 0.25, width: 0.1, height: 0.1 });
  const region = resolveVisualRegion(frame, { cell: "C2" });
  assert.deepEqual(region.normalized, { x: 0.25, y: 0.16666666666666666, width: 0.125, height: 0.16666666666666666 });
  const zoom = { zoomId: "z1", frame, normalized: region.normalized, grid: { columns: 4, rows: 2 } };
  const point = resolveVisualZoomPoint(zoom, { cell: "D2" });
  assert.ok(Math.abs(point.normalized.x - 0.359375) < 1e-12);
  assert.ok(Math.abs(point.normalized.y - 0.2916666666666667) < 1e-12);
  assert.deepEqual(point.screenPoint, { x: 819, y: 342 });
});

test("visual pointer actions use a live frame and the mapped physical point", async () => {
  const frame = createVisualFrame({
    bytes: PNG_1X1,
    imagePath: "frame.png",
    display: { id: "monitor-1", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1.5 },
    activeWindow: { id: 7, title: "Calculator", bounds: null },
    grid: { columns: 4, rows: 2 }
  });
  const controller = Object.create(Computer.prototype);
  controller.closed = false;
  controller.activeSurface = "desktop";
  controller.config = { timeoutMs: 1000 };
  controller.policy = new ActionPolicy({ allowCoordinates: true, allowHeaded: true });
  controller.visualFrames = new Map([[frame.frameId, frame]]);
  controller._desktop = async () => ({ data: [{ id: 7, is_focused: true }] });
  let payload;
  controller._pyautogui = async value => {
    payload = value;
    return { x: value.x, y: value.y };
  };

  const result = await controller.act({
    surface: "desktop",
    action: "double_click",
    pointerDurationMs: 750,
    target: { frameId: frame.frameId, cell: "D2", at: { x: 0.5, y: 0.5 } }
  });

  assert.deepEqual(
    { x: payload.x, y: payload.y, clicks: payload.clicks, durationMs: payload.durationMs },
    { x: 1680, y: 810, clicks: 2, durationMs: 750 }
  );
  assert.equal(result.delivery, "delivered_unverified");
  assert.equal(result.receipt.route.strategy, "visual-cell:D2");
});

test("visual paste clicks once and hands the full text to the clipboard bridge", async () => {
  const frame = createVisualFrame({
    bytes: PNG_1X1,
    imagePath: "frame.png",
    display: { id: "monitor-1", bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    activeWindow: { id: 7, title: "WorkBuddy", bounds: { x: 0, y: 0, width: 1200, height: 800 } },
    grid: { columns: 8, rows: 6 }
  });
  const controller = Object.create(Computer.prototype);
  controller.closed = false;
  controller.activeSurface = "desktop";
  controller.config = { timeoutMs: 1000 };
  controller.policy = new ActionPolicy({ allowCoordinates: true, allowHeaded: true });
  controller.visualFrames = new Map([[frame.frameId, frame]]);
  controller._desktop = async () => ({ data: [{ id: 7, is_focused: true }] });
  controller._pyautogui = async value => ({ x: value.x, y: value.y });
  controller._verifyVisualChange = async () => ({ ok: true, property: "visual_changed", actual: true });
  let pasted = "";
  controller.windowsMcp = {
    async typeAtFocus(text) {
      pasted = text;
      return "ctrl+v";
    }
  };

  const result = await controller.act({
    action: "paste",
    target: { frameId: frame.frameId, cell: "D4" },
    text: "完整的长任务提示词"
  });

  assert.equal(pasted, "完整的长任务提示词");
  assert.match(result.receipt.route.strategy, /visual-paste/);
  assert.equal(result.delivery, "delivered_verified");
});

test("visual pointer actions reject a frame after the active window changes", async () => {
  const frame = createVisualFrame({
    bytes: PNG_1X1,
    imagePath: "frame.png",
    display: { id: "monitor-1", bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    activeWindow: { id: 7, title: "Calculator", bounds: null },
    grid: { columns: 4, rows: 2 }
  });
  const controller = Object.create(Computer.prototype);
  controller.closed = false;
  controller.activeSurface = "desktop";
  controller.config = { timeoutMs: 1000 };
  controller.policy = new ActionPolicy({ allowCoordinates: true, allowHeaded: true });
  controller.visualFrames = new Map([[frame.frameId, frame]]);
  controller._desktop = async () => ({ data: [{ id: 8, is_focused: true }] });
  await assert.rejects(
    controller.act({
      surface: "desktop",
      action: "click",
      target: { frameId: frame.frameId, cell: "A1" }
    }),
    error => error.code === "VISUAL_FRAME_STALE"
  );
});

test("visual zoom actions map through the parent frame before input", async () => {
  const frame = createVisualFrame({
    bytes: PNG_1X1,
    imagePath: "frame.png",
    display: { id: "monitor-1", bounds: { x: 100, y: 50, width: 2000, height: 1000 } },
    activeWindow: { id: 7, title: "Fixture", bounds: null },
    grid: { columns: 8, rows: 6 }
  });
  const controller = Object.create(Computer.prototype);
  controller.closed = false;
  controller.activeSurface = "desktop";
  controller.config = { timeoutMs: 1000 };
  controller.policy = new ActionPolicy({ allowCoordinates: true, allowHeaded: true });
  controller.visualFrames = new Map([[frame.frameId, frame]]);
  controller.visualZooms = new Map([["zoom-1", {
    zoomId: "zoom-1",
    frame,
    normalized: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    grid: { columns: 4, rows: 4 }
  }]]);
  controller._desktop = async () => ({ data: [{ id: 7, is_focused: true }] });
  let payload;
  controller._pyautogui = async value => {
    payload = value;
    return { x: value.x, y: value.y };
  };
  const result = await controller.act({
    surface: "desktop",
    action: "click",
    target: { zoomId: "zoom-1", normalized: { x: 0.5, y: 0.5 } }
  });
  assert.deepEqual(payload, {
    action: "click",
    x: 1100,
    y: 550,
    button: "left",
    clicks: 1,
    timeoutMs: 1000
  });
  assert.equal(result.zoomId, "zoom-1");
});

test("visual_changed verifies that the post-action desktop frame changed", async () => {
  const frame = createVisualFrame({
    bytes: PNG_1X1,
    imagePath: "frame.png",
    display: { id: "monitor-1", bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    activeWindow: { id: 7, title: "Calculator", bounds: null },
    grid: { columns: 4, rows: 2 }
  });
  const controller = Object.create(Computer.prototype);
  controller.closed = false;
  controller.activeSurface = "desktop";
  controller.config = { timeoutMs: 1000 };
  controller.policy = new ActionPolicy({ allowCoordinates: true, allowHeaded: true });
  controller.visualFrames = new Map([[frame.frameId, frame]]);
  let afterPath;
  controller._desktop = async args => {
    if (args[0] === "screenshot") {
      afterPath = args[1];
      writeFileSync(afterPath, Buffer.from("changed-frame"));
    }
    return { data: [{ id: 7, is_focused: true }] };
  };
  controller._pyautogui = async () => ({ ok: true });

  const result = await controller.act({
    surface: "desktop",
    action: "click",
    target: { frameId: frame.frameId, cell: "A1" },
    expect: { property: "visual_changed", timeoutMs: 1 }
  });
  assert.equal(result.verification.ok, true);
  assert.equal(result.delivery, "delivered_verified");
  assert.equal(result.verification.beforeFrameId, frame.frameId);
  assert.notEqual(result.verification.afterFrameId, frame.frameId);
  if (afterPath) unlinkSync(afterPath);
});
