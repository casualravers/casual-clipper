"""Weighted-random, BPM-synced clip cutting + concatenation. Ports cut_clips_random.ps1."""
from __future__ import annotations

import math
import random
import threading
import time
from pathlib import Path
from typing import Callable

import config as app_config  # gui/config.py, absolute import (gui/ is on sys.path)

from . import ffmpeg_utils


def weighted_choice(items: list[dict], weight_key: str, rng: random.Random) -> dict:
    """Cumulative-probability walk, mirroring Get-RandomFolder / Get-RandomClipType."""
    r = rng.random()
    cumulative = 0.0
    for item in items:
        cumulative += float(item.get(weight_key, 0))
        if r <= cumulative:
            return item
    return items[-1]


def _list_source_videos(folder_path: str) -> list[Path]:
    # folder_path is the raw config value and may still contain %USERPROFILE%/relative
    # placeholders (e.g. "%USERPROFILE%/Videos/.../organic") — must be expanded/resolved
    # the same way editsFolder/baseDir are, or it silently matches nothing.
    folder = app_config.resolve_path(folder_path)
    if not folder.is_dir():
        return []
    return list(folder.glob("*.mp4"))


def list_video_counts(paths: list[str]) -> dict[str, int]:
    return {p: len(_list_source_videos(p)) for p in paths}


def sanitize_output_filename(raw_name: str | None) -> str:
    """User-editable output filename: strip path separators (it's a filename, not a path),
    fall back to the default if empty, and force a .mp4 extension since that's the only
    container this pipeline ever produces."""
    name = (raw_name or "").strip()
    name = Path(name).name  # drop any path components the user may have typed
    if not name:
        name = "final_mix.mp4"
    if not name.lower().endswith(".mp4"):
        name += ".mp4"
    return name


def _build_datamosh_transition(
    ffmpeg_path: str,
    clip_a: str,
    clip_b: str,
    window: float,
    fps: int,
    out_path: Path,
    cancel_event: threading.Event,
) -> bool:
    """Blend the tail of clip_a with the head of clip_b into a short corrupted transition
    clip — the tail of A and the head of B are pushed through a heavy eq + RGB-channel-shift
    + strong noise pass each, then combined with 'difference128' (a harsh, flashy blend mode
    that reads as pixel-level corruption, unlike a soft 'lighten' crossfade which just looks
    like a normal dissolve). Both inputs are already scaled/padded identically by the cutting
    loop above, so no extra scale filter is needed here.
    Note: noise's alls= is a 0-100 strength, not a 0-1 fraction — an earlier version passed
    0.15 here, which is next to imperceptible; the actual corrupted/staticky look needs
    something in the 25-40 range."""
    filter_complex = (
        f"[0:v]trim=start=0:duration={window},setpts=PTS-STARTPTS,"
        f"eq=contrast=1.6:brightness=0.15:saturation=1.8,"
        f"rgbashift=rh=6:bh=-6,noise=alls=30:allf=t+u[a];"
        f"[1:v]trim=start=0:duration={window},setpts=PTS-STARTPTS,"
        f"eq=contrast=1.6:brightness=0.15:saturation=1.8,"
        f"rgbashift=rh=-6:bh=6,noise=alls=30:allf=t+u[b];"
        f"[a][b]blend=all_mode=difference128:all_opacity=0.9,"
        f"eq=contrast=1.4,noise=alls=20:allf=t,fps={fps}[out]"
    )
    cmd = [
        ffmpeg_path, "-y",
        "-sseof", f"-{window}", "-i", clip_a,
        "-i", clip_b,
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-an",
        str(out_path),
    ]
    ffmpeg_utils.run(cmd, lambda _line: None, cancel_event)
    return out_path.exists()


def run_generate_job(
    config: dict,
    tool_paths: dict,
    on_log: Callable[[str], None],
    on_progress: Callable[[float, str], None],
    cancel_event: threading.Event,
) -> dict:
    gen = config["generate"]
    source_folders = [f for f in gen.get("sourceFolders", []) if f.get("path")]
    if not source_folders:
        raise ValueError("Aucun dossier source configuré.")

    bpm = float(gen["bpm"])
    beat_duration = 60.0 / bpm
    clip_types = gen.get("clipTypes", [])
    if not clip_types:
        raise ValueError("Aucun type de clip configuré.")
    resolved_clip_types = [
        {**ct, "duration": round(beat_duration * float(ct["beats"]), 2)}
        for ct in clip_types
    ]

    edits_folder = app_config.resolve_path(gen["editsFolder"])
    clips_folder = edits_folder / "clips_normalized"
    ffmpeg_utils.ensure_dir(clips_folder)

    ffmpeg_path = tool_paths["ffmpeg"]
    ffprobe_path = tool_paths["ffprobe"]

    skip_start = float(gen["skipStart"])
    skip_end = float(gen["skipEnd"])
    width, height, fps = int(gen["width"]), int(gen["height"]), int(gen["fps"])
    target_seconds = float(gen["finalVideoDurationMinutes"]) * 60

    videos_by_folder = {f["path"]: _list_source_videos(f["path"]) for f in source_folders}
    total_videos = sum(len(v) for v in videos_by_folder.values())
    if total_videos == 0:
        raise ValueError("Aucune vidéo .mp4 trouvée dans les dossiers sources.")

    on_log(f"[INFO] BPM {bpm} — durée d'un beat {beat_duration:.2f}s")
    on_log(f"[INFO] {total_videos} vidéos disponibles dans {len(source_folders)} dossier(s)")

    rng = random.Random()
    cuts: list[str] = []
    accumulated = 0.0
    clip_index = 0
    start_time = time.time()
    duration_cache: dict[Path, float] = {}

    while accumulated < target_seconds:
        if cancel_event.is_set():
            raise ffmpeg_utils.CancelledError()

        folder = weighted_choice(source_folders, "weight", rng)
        folder_videos = videos_by_folder.get(folder["path"], [])
        if not folder_videos:
            continue

        video = rng.choice(folder_videos)

        if video in duration_cache:
            duration = duration_cache[video]
        else:
            duration = ffmpeg_utils.probe_duration(ffprobe_path, str(video))
            if duration:
                duration_cache[video] = duration
        if not duration:
            continue

        clip_type = weighted_choice(resolved_clip_types, "probability", rng)
        clip_duration = clip_type["duration"]

        min_viable = skip_start + clip_duration + skip_end + 5
        if duration <= min_viable:
            continue

        start_min = int(skip_start)
        start_max = math.floor(duration - clip_duration - skip_end)
        if start_max <= start_min:
            continue

        # PowerShell's Get-Random -Minimum -Maximum is max-exclusive, matching randrange (not randint).
        start = rng.randrange(start_min, start_max)

        clip_name = clips_folder / f"clip_{clip_index:04d}.mp4"

        if clip_index % 10 == 0:
            elapsed_min = round(accumulated)
            on_log(
                f"[DECOUPE] Clip {clip_index + 1} [{clip_type['name']} - {clip_duration}s] "
                f"(Progression : {elapsed_min}s / {int(target_seconds)}s)"
            )

        vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps}"
        )
        cmd = [
            ffmpeg_path, "-y",
            "-ss", str(start), "-t", str(clip_duration),
            "-i", str(video),
            "-vf", vf,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-an",  # the final mix has no audio track — skip decoding/encoding it entirely
            str(clip_name),
        ]

        try:
            ffmpeg_utils.run(cmd, lambda _line: None, cancel_event)
        except ffmpeg_utils.CancelledError:
            raise

        if clip_name.exists():
            cuts.append(str(clip_name))
            accumulated += clip_duration
            clip_index += 1
            on_progress(min(accumulated / target_seconds, 1.0), f"{accumulated / 60:.1f} min / {target_seconds / 60:.0f} min — {len(cuts)} clips")
        else:
            on_log(f"  [ERREUR] Clip {clip_index} non créé")

    if not cuts:
        raise ValueError("Aucun clip créé.")

    datamosh_probability = float(gen.get("datamoshProbability", 0.0))
    datamosh_window = float(gen.get("datamoshWindow", 0.5))
    concat_list = list(cuts)
    mosh_count = 0

    if datamosh_probability > 0 and len(cuts) > 1:
        mosh_folder = edits_folder / "clips_datamosh"
        ffmpeg_utils.ensure_dir(mosh_folder)
        concat_list = [cuts[0]]
        for i in range(len(cuts) - 1):
            if cancel_event.is_set():
                raise ffmpeg_utils.CancelledError()
            if rng.random() < datamosh_probability:
                mosh_path = mosh_folder / f"mosh_{i:04d}.mp4"
                try:
                    ok = _build_datamosh_transition(
                        ffmpeg_path, cuts[i], cuts[i + 1], datamosh_window, fps, mosh_path, cancel_event
                    )
                except ffmpeg_utils.CancelledError:
                    raise
                if ok:
                    concat_list.append(str(mosh_path))
                    mosh_count += 1
                else:
                    on_log(f"  [ERREUR] Transition datamosh {i} non créée")
            concat_list.append(cuts[i + 1])
        if mosh_count:
            on_log(f"[DATAMOSH] {mosh_count} transition(s) corrompue(s) insérée(s) entre les clips")

    on_log("")
    on_log(f"[CONCATENATION] {len(concat_list)} segments, {accumulated / 60:.1f} minutes")

    concat_file = edits_folder / "concat_list.txt"
    with open(concat_file, "w", encoding="utf-8", newline="\n") as f:
        for clip in concat_list:
            f.write(f"file '{clip}'\n")

    output_filename = sanitize_output_filename(gen.get("outputFileName"))
    final_output = ffmpeg_utils.unique_path(edits_folder / output_filename)
    if final_output.name != output_filename:
        on_log(f"[INFO] Le fichier existait déjà, sortie renommée : {final_output.name}")
    if mosh_count:
        # The datamosh transition clips are produced by a different ffmpeg filter chain than
        # the plain cuts, so even at matching codec/crf their encoded SPS/PPS parameter sets
        # differ slightly. A stream-copy concat (fine for uniform hard-cut clips) then plays
        # back with a black flash at every segment boundary in real players like VLC — their
        # decoder resets on each parameter-set change, even though ffmpeg/ffprobe decode the
        # result cleanly and don't show it. Re-encoding the final concat sidesteps this by
        # producing one single, consistent stream. Only paid when datamoshing is actually used.
        on_log("[INFO] Datamoshing actif : ré-encodage de la concaténation finale (plus lent que le stream-copy habituel, évite les flashs noirs à la lecture).")
        concat_cmd = [
            ffmpeg_path, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-an",
            str(final_output),
        ]
    else:
        concat_cmd = [ffmpeg_path, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(final_output)]
    ffmpeg_utils.run(concat_cmd, on_log, cancel_event)

    if not final_output.exists():
        raise ValueError("Échec de la concaténation finale.")

    final_duration = ffmpeg_utils.probe_duration(ffprobe_path, str(final_output)) or 0.0
    elapsed = time.time() - start_time
    on_log(f"[OK] Vidéo créée : {final_output} ({final_duration / 60:.1f} min, {elapsed / 60:.1f} min de traitement)")

    return {
        "outputPath": str(final_output),
        "clipCount": len(cuts),
        "durationSec": final_duration,
        "clipsFolder": str(clips_folder),
        "moshFolder": str(edits_folder / "clips_datamosh"),
        "concatFile": str(concat_file),
    }


def delete_temp_clips(clips_folder: str, concat_file: str, mosh_folder: str = "") -> None:
    import shutil

    folder = Path(clips_folder)
    if folder.exists():
        shutil.rmtree(folder, ignore_errors=True)
    if mosh_folder:
        mosh_path = Path(mosh_folder)
        if mosh_path.exists():
            shutil.rmtree(mosh_path, ignore_errors=True)
    concat_path = Path(concat_file)
    if concat_path.exists():
        concat_path.unlink(missing_ok=True)
