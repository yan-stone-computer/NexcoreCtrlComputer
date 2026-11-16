import assert from "node:assert/strict";
import test from "node:test";
import { ActionPolicy, Computer } from "../src/index.js";
import {
  createVisualFrame,
  imageDimensions,
  normalizeVisualGrid,
  resolveVisualPoint,
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

test("visual frame validation rejects unsupported grids and reports expiry", () => {
  assert.deepEqual(normalizeVisualGrid(), { columns: 8, rows: 6 });
  assert.throws(() => normalizeVisualGrid({ columns: 1, rows: 6 }), /columns/);
  const dimensions = imageDimensions(PNG_1X1);
  assert.deepEqual(dimensions, { width: 1, height: 1, mimeType: "image/png" });
  assert.equal(visualFrameExpired({ expiresAt: 99 }, 100), true);
  assert.equal(visualFrameExpired({ expiresAt: 101 }, 100), false);
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
    target: { frameId: frame.frameId, cell: "D2", at: { x: 0.5, y: 0.5 } }
  });

  assert.deepEqual({ x: payload.x, y: payload.y, clicks: payload.clicks }, { x: 1680, y: 810, clicks: 2 });
  assert.equal(result.delivery, "delivered_unverified");
  assert.equal(result.receipt.route.strategy, "visual-cell:D2");
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
