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
  if (target.candidateId !== undefined) {
    const candidate = (frame.candidates || []).find(item => String(item.id) === String(target.candidateId));
    if (!candidate) throw visualError("VISUAL_CANDIDATE_UNKNOWN", `Unknown visual candidate: ${target.candidateId}`);
    normalized = candidate.normalized;
    strategy = `visual-candidate:${candidate.id}`;
  } else if (target.cell !== undefined) {
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

export function resolveVisualRegion(frame, region = {}) {
  if (region.candidateId !== undefined) {
    const candidate = (frame.candidates || []).find(item => String(item.id) === String(region.candidateId));
    if (!candidate) throw visualError("VISUAL_CANDIDATE_UNKNOWN", `Unknown visual candidate: ${region.candidateId}`);
    return {
      crop: [
        Math.max(0, Math.floor(candidate.bounds.x)),
        Math.max(0, Math.floor(candidate.bounds.y)),
        Math.min(frame.width, Math.ceil(candidate.bounds.x + candidate.bounds.width)),
        Math.min(frame.height, Math.ceil(candidate.bounds.y + candidate.bounds.height))
      ],
      normalized: {
        x: candidate.bounds.x / frame.width,
        y: candidate.bounds.y / frame.height,
        width: candidate.bounds.width / frame.width,
        height: candidate.bounds.height / frame.height
      },
      source: `candidate:${candidate.id}`
    };
  }
  let normalized;
  let source;
  if (region.cell !== undefined) {
    const cell = parseCell(region.cell, frame.grid);
    normalized = {
      x: cell.column / frame.grid.columns,
      y: cell.row / frame.grid.rows,
      width: 1 / frame.grid.columns,
      height: 1 / frame.grid.rows
    };
    source = `cell:${String(region.cell).toUpperCase()}`;
  } else if (region.normalized) {
    const x = Number(region.normalized.x);
    const y = Number(region.normalized.y);
    const width = Number(region.normalized.width);
    const height = Number(region.normalized.height);
    if ([x, y, width, height].some(value => !Number.isFinite(value) || value < 0 || value > 1) || width <= 0 || height <= 0) {
      throw visualError("INVALID_VISUAL_REGION", "normalized region needs x, y, width, height between 0 and 1.");
    }
    normalized = { x, y, width, height };
    source = "normalized";
  } else {
    throw visualError("VISUAL_REGION_REQUIRED", "Zoom needs candidateId, cell, or normalized region.");
  }
  const left = Math.floor(normalized.x * frame.width);
  const top = Math.floor(normalized.y * frame.height);
  const right = Math.min(frame.width, Math.ceil((normalized.x + normalized.width) * frame.width));
  const bottom = Math.min(frame.height, Math.ceil((normalized.y + normalized.height) * frame.height));
  if (right <= left || bottom <= top) throw visualError("INVALID_VISUAL_REGION", "Visual region is empty.");
  return { crop: [left, top, right, bottom], normalized, source };
}

export function resolveVisualZoomPoint(zoom, target = {}) {
  if (!zoom?.frame || !zoom?.normalized) throw visualError("VISUAL_ZOOM_INVALID", "Visual zoom metadata is incomplete.");
  let local;
  let strategy;
  if (target.cell !== undefined) {
    const cell = parseCell(target.cell, zoom.grid);
    const at = normalizedOffset(target.at);
    local = {
      x: (cell.column + at.x) / zoom.grid.columns,
      y: (cell.row + at.y) / zoom.grid.rows
    };
    strategy = `visual-zoom-cell:${String(target.cell).toUpperCase()}`;
  } else if (target.normalized) {
    local = normalizedOffset(target.normalized);
    strategy = "visual-zoom-normalized";
  } else {
    throw visualError("VISUAL_TARGET_REQUIRED", "Zoom target needs cell or normalized {x,y}.");
  }
  const normalized = {
    x: zoom.normalized.x + local.x * zoom.normalized.width,
    y: zoom.normalized.y + local.y * zoom.normalized.height
  };
  const frame = zoom.frame;
  return {
    frameId: frame.frameId,
    zoomId: zoom.zoomId,
    strategy,
    normalized,
    imagePoint: {
      x: Math.round(normalized.x * frame.width),
      y: Math.round(normalized.y * frame.height)
    },
    screenPoint: {
      x: Math.round(frame.display.bounds.x + normalized.x * frame.display.bounds.width),
      y: Math.round(frame.display.bounds.y + normalized.y * frame.display.bounds.height)
    }
  };
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
