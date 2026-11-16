import { createHash } from "node:crypto";

export const VISUAL_FRAME_SCHEMA = "nexcore.visual.frame/v1";

function visualError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

export function imageDimensions(buffer) {
  if (
    buffer.length >= 24
    && buffer[0] === 0x89
    && buffer.subarray(1, 4).toString("ascii") === "PNG"
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), mimeType: "image/png" };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      if (marker >= 0xd0 && marker <= 0xd7) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
          mimeType: "image/jpeg"
        };
      }
      offset += 2 + length;
    }
  }
  throw visualError("VISUAL_IMAGE_UNSUPPORTED", "Visual frame needs a PNG or JPEG screenshot.");
}

export function normalizeVisualGrid(value = {}) {
  const integer = (candidate, fallback, field) => {
    const number = Number(candidate ?? fallback);
    if (!Number.isInteger(number) || number < 2 || number > 16) {
      throw visualError("INVALID_VISUAL_GRID", `${field} must be an integer from 2 to 16.`, { field, value: candidate });
    }
    return number;
  };
  return {
    columns: integer(value.columns, 8, "columns"),
    rows: integer(value.rows, 6, "rows")
  };
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function parseCell(cell, grid) {
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(String(cell || "").trim().toUpperCase());
  if (!match) throw visualError("INVALID_VISUAL_CELL", "cell must look like C4.");
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column < 1 || column > grid.columns || row < 1 || row > grid.rows) {
    throw visualError(
      "INVALID_VISUAL_CELL",
      `cell must be between A1 and ${columnName(grid.columns - 1)}${grid.rows}.`
    );
  }
  return { column: column - 1, row: row - 1 };
}

function normalizedOffset(at = {}) {
  const value = (candidate, fallback, name) => {
    const number = Number(candidate ?? fallback);
    if (!Number.isFinite(number) || number < 0 || number > 1) {
      throw visualError("INVALID_VISUAL_POINT", `${name} must be between 0 and 1.`);
    }
    return number;
  };
  return { x: value(at.x, 0.5, "at.x"), y: value(at.y, 0.5, "at.y") };
}

export function createVisualFrame({
  bytes,
  imagePath,
  display,
  activeWindow = null,
  grid,
  createdAt = Date.now(),
  ttlMs = 30000
}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw visualError("VISUAL_IMAGE_MISSING", "Screenshot bytes are missing.");
  if (!imagePath) throw visualError("VISUAL_IMAGE_MISSING", "Screenshot path is missing.");
  if (!display?.bounds || !Number.isFinite(Number(display.bounds.width)) || !Number.isFinite(Number(display.bounds.height))) {
    throw visualError("DISPLAY_UNAVAILABLE", "A display with finite bounds is required.");
  }
  const image = imageDimensions(bytes);
  const normalizedGrid = normalizeVisualGrid(grid);
  return {
    schema: VISUAL_FRAME_SCHEMA,
    frameId: createHash("sha256").update(bytes).digest("hex"),
    imagePath,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    display: {
      id: String(display.id || ""),
      bounds: {
        x: Number(display.bounds.x || 0),
        y: Number(display.bounds.y || 0),
        width: Number(display.bounds.width),
        height: Number(display.bounds.height)
      },
      scale: Number(display.scale) || 1,
      isPrimary: display.is_primary === true
    },
    activeWindow: activeWindow ? {
      id: activeWindow.id,
      title: String(activeWindow.title || ""),
      bounds: activeWindow.bounds || null
    } : null,
    grid: {
      ...normalizedGrid,
      cellWidth: image.width / normalizedGrid.columns,
      cellHeight: image.height / normalizedGrid.rows
    },
    createdAt,
    expiresAt: createdAt + ttlMs
  };
}

export function visualFrameExpired(frame, now = Date.now()) {
  return !frame || !Number.isFinite(frame.expiresAt) || frame.expiresAt <= now;
}

export function resolveVisualPoint(frame, target = {}) {
  if (!frame?.display?.bounds || !frame?.grid) throw visualError("VISUAL_FRAME_INVALID", "Visual frame metadata is incomplete.");
  let normalized;
  let strategy;
  if (target.cell !== undefined) {
    const cell = parseCell(target.cell, frame.grid);
    const at = normalizedOffset(target.at);
    normalized = {
      x: (cell.column + at.x) / frame.grid.columns,
      y: (cell.row + at.y) / frame.grid.rows
    };
    strategy = `visual-cell:${String(target.cell).toUpperCase()}`;
  } else if (target.normalized) {
    const point = normalizedOffset(target.normalized);
    normalized = point;
    strategy = "visual-normalized";
  } else {
    throw visualError("VISUAL_TARGET_REQUIRED", "Visual target needs cell or normalized {x,y}.");
  }
  const imagePoint = {
    x: Math.round(normalized.x * frame.width),
    y: Math.round(normalized.y * frame.height)
  };
  const screenPoint = {
    x: Math.round(frame.display.bounds.x + normalized.x * frame.display.bounds.width),
    y: Math.round(frame.display.bounds.y + normalized.y * frame.display.bounds.height)
  };
  return { frameId: frame.frameId, strategy, normalized, imagePoint, screenPoint };
}

export function visualFrameText(frame) {
  const maxCell = `${columnName(frame.grid.columns - 1)}${frame.grid.rows}`;
  const window = frame.activeWindow
    ? `activeWindow=${frame.activeWindow.id} "${frame.activeWindow.title}"`
    : "activeWindow=unknown";
  return [
    `visual frame ${frame.frameId.slice(0, 16)} · ${frame.width}x${frame.height} · ${frame.mimeType}`,
    `display=${frame.display.id || "unknown"} bounds=${frame.display.bounds.x},${frame.display.bounds.y},${frame.display.bounds.width},${frame.display.bounds.height} scale=${frame.display.scale}`,
    window,
    `grid=${frame.grid.columns}x${frame.grid.rows} · columns A-${columnName(frame.grid.columns - 1)} left-to-right · rows 1-${frame.grid.rows} top-to-bottom · cells A1-${maxCell}`,
    `expiresAt=${new Date(frame.expiresAt).toISOString()}`,
    `act with target={"frameId":"${frame.frameId}","cell":"C4"}`,
    `path=${frame.imagePath}`
  ].join("\n");
}
