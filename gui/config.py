"""Load/save/normalize config.json, and resolve configured paths to absolute paths."""
from __future__ import annotations

import concurrent.futures
import copy
import json
import os
import shutil
from pathlib import Path

# shutil.which() scans every directory on PATH; if PATH contains an unreachable network
# path (disconnected VPN drive, offline share...), a single lookup can hang for Windows'
# SMB timeout (tens of seconds). Detection runs on every app startup, so it's bounded to a
# worker thread with a timeout rather than allowed to block startup indefinitely.
_WHICH_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="which")


def _which_with_timeout(name: str, timeout: float = 1.5) -> str | None:
    future = _WHICH_EXECUTOR.submit(shutil.which, name)
    try:
        return future.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        return None

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "config.json"

DEFAULT_CONFIG = {
    "version": 1,
    "paths": {
        "ffmpegPath": "ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe",
        "ffprobePath": "ffmpeg-8.0.1-essentials_build/bin/ffprobe.exe",
        "ytDlpPath": "yt-dlp.exe",
    },
    "download": {
        "baseDir": "%USERPROFILE%/Videos/VHS-Glitch-Mix/downloads",
        # bv*+ba (adaptive) rather than a pre-merged "best" stream: YouTube has mostly
        # stopped serving pre-merged progressive formats above 360p, so "best[height<=480]"
        # alone now fails with "Requested format is not available" on most videos.
        "format": "bv*[height<=480]+ba/b[height<=480]",
        "playlists": [{"playlistUrl": "", "folderName": ""}],
    },
    "generate": {
        "editsFolder": "%USERPROFILE%/Videos/VHS-Glitch-Mix/edits/Projet_VHS_Glitch",
        "outputFileName": "final_mix.mp4",
        "finalVideoDurationMinutes": 80,
        "sourceFolders": [{"path": "", "weight": 0.25}],
        "skipStart": 5,
        "skipEnd": 5,
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "bpm": 150,
        "clipTypes": [
            {"name": "4beats", "beats": 4, "probability": 0.20},
            {"name": "8beats", "beats": 8, "probability": 0.35},
            {"name": "16beats", "beats": 16, "probability": 0.30},
            {"name": "32beats", "beats": 32, "probability": 0.15},
        ],
        "deleteTempClipsAfterConcat": False,
        # Datamoshing: probability (0.0-1.0) that a given cut between two clips gets a
        # blended/corrupted transition instead of a hard cut, and the transition's length.
        "datamoshProbability": 0.0,
        "datamoshWindow": 0.5,
    },
    "glitch": {
        "lastInputVideo": "",
        "effect": "glitch",
        "width": 1920,
        "height": 1080,
        "fps": 30,
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                on_disk = json.load(f)
            return _deep_merge(DEFAULT_CONFIG, on_disk)
        except (json.JSONDecodeError, OSError):
            return copy.deepcopy(DEFAULT_CONFIG)
    return copy.deepcopy(DEFAULT_CONFIG)


def normalize_weights(items: list[dict], key: str) -> tuple[list[dict], str | None]:
    """Normalize items[key] to sum to 1.0, always rounded to 2 decimal places (matches the
    number inputs' step="0.01" in the UI). Returns (items, warning_message|None)."""
    if not items:
        return items, None
    total = sum(float(item.get(key, 0)) for item in items)
    if total <= 0:
        equal = round(1.0 / len(items), 2)
        for item in items:
            item[key] = equal
        return items, "Les poids étaient à 0 — répartis équitablement."
    if abs(total - 1.0) > 0.01:
        for item in items:
            item[key] = round(float(item.get(key, 0)) / total, 2)
        return items, f"Les poids ne totalisaient pas 100% (total {total * 100:.1f}%) — normalisés."
    for item in items:
        item[key] = round(float(item.get(key, 0)), 2)
    return items, None


def save_config(config: dict) -> dict:
    normalized = copy.deepcopy(config)

    if "generate" in normalized:
        gen = normalized["generate"]
        if gen.get("sourceFolders"):
            gen["sourceFolders"], _ = normalize_weights(gen["sourceFolders"], "weight")
        if gen.get("clipTypes"):
            gen["clipTypes"], _ = normalize_weights(gen["clipTypes"], "probability")

    merged = _deep_merge(DEFAULT_CONFIG, normalized)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2, ensure_ascii=False)
    return merged


def resolve_path(raw_path: str) -> Path:
    """Expand %VARS%/~ and resolve relative paths against the repo root."""
    expanded = os.path.expandvars(raw_path)
    expanded = os.path.expanduser(expanded)
    p = Path(expanded)
    if not p.is_absolute():
        p = REPO_ROOT / p
    return p


def _find_tool(configured_path: str, command_names: list[str]) -> str:
    """Resolve a tool to an actual usable path: the configured/bundled path if it exists,
    else the first match on the system PATH (covers winget/choco/scoop installs), else the
    configured path unchanged (so the caller can still report *where* it looked)."""
    bundled = resolve_path(configured_path)
    if bundled.is_file():
        return str(bundled)
    for name in command_names:
        found = _which_with_timeout(name)
        if found:
            return found
    return str(bundled)


def resolve_tool_paths(config: dict) -> dict:
    paths = config.get("paths", {})
    return {
        "ffmpeg": _find_tool(paths.get("ffmpegPath", ""), ["ffmpeg", "ffmpeg.exe"]),
        "ffprobe": _find_tool(paths.get("ffprobePath", ""), ["ffprobe", "ffprobe.exe"]),
        "ytDlp": _find_tool(paths.get("ytDlpPath", ""), ["yt-dlp", "yt-dlp.exe"]),
    }
