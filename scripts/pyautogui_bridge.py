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
            from PIL import Image
            source = str(request["inputPath"])
            target = str(request["outputPath"])
            max_width = max(320, min(3840, int(request.get("maxWidth", 1600))))
            quality = max(40, min(95, int(request.get("quality", 82))))
            with Image.open(source) as image:
                image = image.convert("RGB")
                if image.width > max_width:
                    height = max(1, round(image.height * max_width / image.width))
                    image = image.resize((max_width, height), Image.Resampling.LANCZOS)
                image.save(target, "JPEG", quality=quality, optimize=True)
                result = {
                    "path": target,
                    "width": image.width,
                    "height": image.height,
                    "mimeType": "image/jpeg",
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
            pyautogui.click(x, y, clicks=clicks, button=button)
            result = {"x": x, "y": y, "clicks": clicks, "button": button}
        elif action == "move":
            x, y = int(request["x"]), int(request["y"])
            width, height = pyautogui.size()
            if not (0 <= x < width and 0 <= y < height):
                raise ValueError("coordinates are outside the primary display")
            pyautogui.moveTo(x, y)
            result = {"x": x, "y": y}
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
