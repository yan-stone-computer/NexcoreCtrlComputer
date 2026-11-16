#!/usr/bin/env python3
"""Minimal stdin/stdout bridge. PyAutoGUI is loaded only for coordinate fallback."""

import json
import sys


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except Exception as exc:
        print(json.dumps({"ok": False, "code": "INVALID_INPUT", "message": str(exc)}))
        return 2

    action = request.get("action")
    if action == "preview":
        try:
            from PIL import Image, ImageDraw, ImageFont
            source = str(request["inputPath"])
            target = str(request["outputPath"])
            max_width = max(320, min(3840, int(request.get("maxWidth", 1600))))
            quality = max(40, min(95, int(request.get("quality", 82))))
            crop = request.get("crop")
            grid = request.get("grid") or {}
            marks = request.get("marks") or []
            with Image.open(source) as image:
                image = image.convert("RGB")
                source_width, source_height = image.size
                if isinstance(crop, list) and len(crop) == 4:
                    left, top, right, bottom = [int(value) for value in crop]
                    left = max(0, min(source_width - 1, left))
                    top = max(0, min(source_height - 1, top))
                    right = max(left + 1, min(source_width, right))
                    bottom = max(top + 1, min(source_height, bottom))
                    image = image.crop((left, top, right, bottom))
                else:
                    left, top = 0, 0
                    right, bottom = source_width, source_height
                crop_width = right - left
                crop_height = bottom - top
                if image.width > max_width:
                    height = max(1, round(image.height * max_width / image.width))
                    image = image.resize((max_width, height), Image.Resampling.LANCZOS)
                overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
                draw = ImageDraw.Draw(overlay)
                font = ImageFont.load_default()
                columns = int(grid.get("columns", 0))
                rows = int(grid.get("rows", 0))
                if columns >= 2 and rows >= 2:
                    for column in range(columns + 1):
                        x = round(column * image.width / columns)
                        draw.line((x, 0, x, image.height), fill=(47, 188, 215, 135), width=1)
                    for row in range(rows + 1):
                        y = round(row * image.height / rows)
                        draw.line((0, y, image.width, y), fill=(47, 188, 215, 135), width=1)
                    for column in range(columns):
                        x = round((column + 0.5) * image.width / columns)
                        draw.text((x, 3), chr(65 + column), fill=(255, 255, 255, 230), font=font, anchor="mt")
                    for row in range(rows):
                        y = round((row + 0.5) * image.height / rows)
                        draw.text((3, y), str(row + 1), fill=(255, 255, 255, 230), font=font, anchor="lm")
                scale_x = image.width / crop_width
                scale_y = image.height / crop_height
                for mark in marks:
                    bounds = mark.get("bounds") or {}
                    if not all(key in bounds for key in ("x", "y", "width", "height")):
                        continue
                    x = round((float(bounds["x"]) - left) * scale_x)
                    y = round((float(bounds["y"]) - top) * scale_y)
                    w = max(2, round(float(bounds["width"]) * scale_x))
                    h = max(2, round(float(bounds["height"]) * scale_y))
                    draw.rectangle((x, y, x + w, y + h), outline=(255, 66, 66, 235), width=2)
                    draw.text((x + 2, max(0, y - 13)), str(mark.get("id", "")), fill=(255, 255, 255, 255), font=font)
                image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
                image.save(target, "JPEG", quality=quality, optimize=True)
                result = {
                    "path": target,
                    "width": image.width,
                    "height": image.height,
                    "mimeType": "image/jpeg",
                    "crop": [left, top, right, bottom],
                    "scale": {"x": scale_x, "y": scale_y},
                }
            print(json.dumps({"ok": True, "data": result}, ensure_ascii=False))
            return 0
        except Exception as exc:
            print(json.dumps({
                "ok": False,
                "code": "PREVIEW_UNAVAILABLE",
                "message": str(exc),
            }))
            return 4

    try:
        import pyautogui
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "code": "PYAUTOGUI_MISSING",
            "message": "Install optional coordinate fallback with: python -m pip install pyautogui",
            "details": str(exc),
        }))
        return 3

    # The corner kill switch stays enabled. Zero pause is deliberate: semantic
    # accessibility actions are preferred and coordinate use is opt-in.
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0
    try:
        if action == "status":
            size = pyautogui.size()
            position = pyautogui.position()
            result = {
                "size": {"width": size.width, "height": size.height},
                "position": {"x": position.x, "y": position.y},
                "failsafe": bool(pyautogui.FAILSAFE),
            }
        elif action == "position":
            position = pyautogui.position()
            result = {"x": position.x, "y": position.y}
        elif action == "click":
            x, y = int(request["x"]), int(request["y"])
            width, height = pyautogui.size()
            if not (0 <= x < width and 0 <= y < height):
                raise ValueError("coordinates are outside the primary display")
            clicks = max(1, min(3, int(request.get("clicks", 1))))
            button = str(request.get("button", "left"))
            if button not in {"left", "middle", "right"}:
                raise ValueError("button must be left, middle, or right")
            duration = max(0.0, min(5.0, float(request.get("durationMs", 0)) / 1000))
            if duration:
                pyautogui.moveTo(x, y, duration=duration)
            pyautogui.click(x, y, clicks=clicks, button=button)
            result = {"x": x, "y": y, "clicks": clicks, "button": button, "durationMs": round(duration * 1000)}
        elif action == "move":
            x, y = int(request["x"]), int(request["y"])
            width, height = pyautogui.size()
            if not (0 <= x < width and 0 <= y < height):
                raise ValueError("coordinates are outside the primary display")
            duration = max(0.0, min(5.0, float(request.get("durationMs", 0)) / 1000))
            pyautogui.moveTo(x, y, duration=duration)
            result = {"x": x, "y": y, "durationMs": round(duration * 1000)}
        elif action == "type":
            pyautogui.write(str(request.get("text", "")), interval=0)
            result = {"typed": True}
        elif action == "press":
            pyautogui.press(str(request["key"]))
            result = {"pressed": request["key"]}
        elif action == "hotkey":
            keys = [str(key) for key in request["keys"]]
            pyautogui.hotkey(*keys)
            result = {"hotkey": keys}
        elif action == "screenshot":
            path = request.get("path")
            image = pyautogui.screenshot()
            if path:
                image.save(path)
            result = {"path": path, "size": {"width": image.width, "height": image.height}}
        else:
            raise ValueError(f"unknown action: {action}")
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "code": "PYAUTOGUI_ERROR", "message": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
