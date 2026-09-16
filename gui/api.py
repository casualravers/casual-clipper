"""Api class exposed to the frontend via pywebview's js_api."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

import config as app_config
from jobs import JobManager
from pipeline import download, effects, ffmpeg_utils, generate


class Api:
    def __init__(self) -> None:
        self._window = None
        self.jobs = JobManager()
        self._config = app_config.load_config()

    # ---- config ----

    def get_config(self) -> dict:
        self._config = app_config.load_config()
        return self._config

    def save_config(self, config: dict) -> dict:
        self._config = app_config.save_config(config)
        return self._config

    # ---- filesystem dialogs ----

    def browse_folder(self, current_path: str = "") -> str | None:
        if self._window is None:
            return None
        import webview

        start_dir = current_path if current_path and Path(current_path).is_dir() else str(Path.home())
        result = self._window.create_file_dialog(webview.FOLDER_DIALOG, directory=start_dir)
        if result:
            return result[0]
        return None

    def browse_file(self, current_path: str = "", file_types: list[str] | None = None) -> str | None:
        if self._window is None:
            return None
        import webview

        start_dir = str(Path(current_path).parent) if current_path and Path(current_path).exists() else str(Path.home())
        types = tuple(file_types) if file_types else ("Fichiers vidéo (*.mp4;*.mkv;*.mov)", "Tous les fichiers (*.*)")
        result = self._window.create_file_dialog(webview.OPEN_DIALOG, directory=start_dir, file_types=types)
        if result:
            return result[0]
        return None

    # ---- jobs ----

    def start_download(self) -> str:
        tool_paths = app_config.resolve_tool_paths(self._config)
        return self.jobs.start("download", download.run_download_job, self._config, tool_paths)

    def start_generate(self) -> str:
        tool_paths = app_config.resolve_tool_paths(self._config)
        return self.jobs.start("generate", generate.run_generate_job, self._config, tool_paths)

    def start_glitch(self, input_video: str, effect: str) -> str:
        tool_paths = app_config.resolve_tool_paths(self._config)
        glitch_cfg = self._config["glitch"]
        # input_video is free text (may still hold a %USERPROFILE%/relative placeholder if
        # typed rather than picked via Browse) — resolve it the same way every other
        # config path is resolved, or a typed-in path silently matches nothing.
        input_video = str(app_config.resolve_path(input_video))
        output_video = effects.derive_output_path(input_video, effect)
        return self.jobs.start(
            "glitch",
            effects.run_effect_job,
            input_video,
            output_video,
            effect,
            int(glitch_cfg["width"]),
            int(glitch_cfg["height"]),
            int(glitch_cfg["fps"]),
            tool_paths,
        )

    def cancel_job(self, job_id: str) -> bool:
        return self.jobs.cancel(job_id)

    def get_job_events(self, job_id: str, since_seq: int = 0) -> dict:
        return self.jobs.get_events(job_id, since_seq)

    def get_job_status(self, job_id: str) -> dict:
        return self.jobs.get_status(job_id)

    def delete_temp_clips(self, clips_folder: str, concat_file: str, mosh_folder: str = "") -> bool:
        generate.delete_temp_clips(clips_folder, concat_file, mosh_folder)
        return True

    # ---- misc ----

    def list_source_videos(self, paths: list[str]) -> dict[str, int]:
        return generate.list_video_counts(paths)

    def check_prereqs(self) -> dict:
        tool_paths = app_config.resolve_tool_paths(self._config)
        return {
            "ffmpeg": Path(tool_paths["ffmpeg"]).is_file(),
            "ffprobe": Path(tool_paths["ffprobe"]).is_file(),
            "ytDlp": Path(tool_paths["ytDlp"]).is_file(),
            "resolvedPaths": tool_paths,
        }

    def update_yt_dlp(self) -> dict:
        """yt-dlp needs frequent updates to keep working against YouTube's changes (an
        install a few months old routinely starts failing with HTTP 403). Runs its
        built-in self-updater; if the resolved binary is a system install (not bundled),
        this still works — yt-dlp updates itself in place either way."""
        tool_paths = app_config.resolve_tool_paths(self._config)
        yt_dlp_path = tool_paths["ytDlp"]
        try:
            result = subprocess.run(
                [yt_dlp_path, "-U"],
                capture_output=True,
                text=True,
                timeout=60,
                creationflags=ffmpeg_utils.CREATE_NO_WINDOW,
            )
            output = (result.stdout + result.stderr).strip()
            return {"ok": result.returncode == 0, "output": output}
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"ok": False, "output": str(exc)}

    def open_output_folder(self, path: str) -> None:
        target = Path(path)
        folder = target if target.is_dir() else target.parent
        if folder.exists():
            os.startfile(folder)  # noqa: S606 - Regular action, opens Explorer at a local path

    def on_window_closing(self) -> None:
        self.jobs.terminate_all()
        self.jobs.wait_for_idle(timeout=3.0)
