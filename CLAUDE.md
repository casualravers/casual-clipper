# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small collection of standalone PowerShell + FFmpeg scripts that build "VHS Glitch" style video mixes: download YouTube playlists, cut randomized clips from the downloaded footage (optionally synced to a BPM grid), concatenate them into a long final video, and optionally apply a glitch/datamosh post-effect. There is no application code, package manager, build system, or test suite — each `.ps1` file is run directly and independently in PowerShell.

## Running the scripts

Requires FFmpeg (`ffmpeg-8.0.1-essentials_build`) and `yt-dlp.exe` (bundled in this repo). If script execution is blocked, run once:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Typical pipeline, run in order:

```powershell
.\sanitize_video_names.ps1   # downloads YouTube playlist(s) via yt-dlp, sanitizes resulting filenames
.\cut_clips_random.ps1       # cuts BPM-synced random-duration clips from weighted source folders, concatenates to final_mix.mp4
.\add_glitch_effect.ps1      # optional post-process glitch filter on the final mix (experimental, per README not recommended)
```

`cut_clips_10s.ps1` is an alternate to `cut_clips_random.ps1`: fixed 10s clips from a single source folder (no BPM sync, no folder weighting), and includes an interactive datamoshing pass (`Read-Host` prompt) after concatenation.

There are no lint or test commands — validate changes by running the affected script against a small source folder and confirming the output file is produced.

## Architecture / data flow

Each script is self-contained with a `# ======== CONFIGURATION ========` block of `$variables` at the top (resolution, BPM, folder weights, etc.) — there is no shared config file. To change behavior, edit the variables directly in the relevant script.

The one exception is tool/path resolution: every script dot-sources `resolve_tools.ps1` (`. "$PSScriptRoot\resolve_tools.ps1"`) at the top of its CONFIGURATION block. That shared file resolves `$FfmpegPath`/`$FfprobePath`/`$YtDlpPath` (bundled next to the scripts first, falling back to whatever's on the system PATH — covers winget/choco/scoop installs) and `$MixHome` (defaults to `%USERPROFILE%\Videos\VHS-Glitch-Mix`, overridable via `$env:VHS_MIX_HOME`). This exists specifically so the scripts work on a machine other than the original author's without editing hardcoded paths — see `resolve_tools.ps1` before assuming a script needs a path hardcoded.

Pipeline stages:
1. **Download + sanitize** (`sanitize_video_names.ps1`): iterates a `$playlists` array (playlist URL + target folder name), calls `yt-dlp.exe` (via `resolve_tools.ps1`'s `$YtDlpPath`) to fetch each playlist at ≤480p into `$baseDir\<folderName>`, then strips non-word characters from filenames. Despite the filename, this script is the actual combined download+sanitize logic — there is no separate `download_playlists_480p.ps1` in the repo.
2. **Clip generation** (`cut_clips_random.ps1` / `cut_clips_10s.ps1`, ported to `gui/pipeline/generate.py`): scans one or more source folders for `*.mp4`, and in a loop until a target total duration is reached: picks a source video (weighted by folder in the `_random` variant), picks a random in-bounds start offset (`ffprobe` for duration, respecting `$skipStart`/`$skipEnd` — duration lookups are cached per video path since the same video is often picked multiple times), cuts a clip via `ffmpeg` (scaled/padded to `$width`x`$height`@`$fps`, `-an` — the mix is silent by design, meant to be mixed/projected with its own audio source), and appends it to a running list. `cut_clips_random.ps1` additionally rolls a random clip *type* per cut (4/8/16/32 beats at `$bpm`, via `Get-RandomClipType`) and a random source *folder* per cut (via `Get-RandomFolder`, weighted by `$sourceFolders[].weight`). Clips are written to a `clips_*` subfolder, listed in an ffmpeg concat file, then concatenated (stream copy) into `final_mix*.mp4`.
   - **Datamoshing between clips** (`$datamoshProbability`/`$datamoshWindow` in `cut_clips_random.ps1`, `generate.datamoshProbability`/`generate.datamoshWindow` in the GUI): after the cut loop, for each boundary between two consecutive clips, with probability `$datamoshProbability` a short corrupted transition clip is generated instead of a hard cut — `ffmpeg` blends the last `$datamoshWindow` seconds of clip A with the first `$datamoshWindow` seconds of clip B (`eq` contrast/brightness shift + `blend=all_mode=lighten` + `noise`), producing a `mosh_NNNN.mp4` in a `clips_datamosh` subfolder. These transition clips are spliced into the concat list between the two clips they bridge, so the final stream-copy concat still works unmodified (same codec/resolution/fps as the regular clips). 0 (default) disables it entirely — pure hard cuts, matching prior behavior. This is distinct from the *post-processing* datamosh effect below, which blends a single video with itself rather than bridging two different clips.
3. **Post-effects** (`add_glitch_effect.ps1`, and the optional datamosh block at the end of `cut_clips_10s.ps1`): re-encodes the final mix through an `ffmpeg` filtergraph (scan-line/noise/hue shift for glitch; a `split`+`blend` filtergraph for datamosh) into a separate output file.

Source folders and output folders default to subfolders of `$MixHome` (see `resolve_tools.ps1` above) — portable out of the box, but still just plain `$variables` you're expected to repoint per the CONFIGURATION-block convention once real source folders exist (e.g. after running `sanitize_video_names.ps1`).

`.gitignore` excludes the bundled `ffmpeg-8.0.1-essentials_build/` directory (not committed). It's optional, not required: if absent, `resolve_tools.ps1` (and the GUI's `gui/config.py`) fall back to an ffmpeg/ffprobe/yt-dlp already on the system PATH.

## GUI application (`gui/`)

A desktop GUI wraps the same pipeline in one app with 3 tabs (Téléchargement / Génération / Effet Glitch), replacing manual `.ps1` edits with a form + `config.json`. Built with **Python + pywebview** (native window on Windows' built-in Edge WebView2 runtime — chosen because this environment has no Node/Rust toolchain) and a hand-written HTML/CSS/JS frontend (no framework, no build step).

Run it:
```powershell
py -m pip install -r requirements.txt   # one-time
py gui\app.py                            # or double-click run_gui.bat
```

Key points for future changes:
- **It's a from-scratch Python port of the `.ps1` logic, not a wrapper that shells out to them.** The `.ps1` scripts are untouched and remain independently runnable as the CLI/reference implementation — see `gui/pipeline/{download,generate,effects}.py` for the ported equivalents of `sanitize_video_names.ps1`, `cut_clips_random.ps1`, and `add_glitch_effect.ps1`/`cut_clips_10s.ps1`'s datamosh block, respectively. Porting notes (max-exclusive `Get-Random` → `random.randrange`, etc.) are documented as comments at the relevant call sites.
- **`config.json`** (repo root) holds all user settings (tool paths, playlists, weighted source folders, BPM/clip-type weights, output folders). It's gitignored — `gui/config.py`'s `DEFAULT_CONFIG` is the fallback so the app works with no file present, and every default path is machine-agnostic (`%USERPROFILE%/Videos/VHS-Glitch-Mix/...`, tool paths relative to the repo root — no hardcoded username anywhere). `clipTypes` store `beats`, not a precomputed duration; duration is always derived from `beats * 60/bpm` at read time so it can't desync from BPM edits.
- **Tool auto-detection**: `gui/config.py`'s `resolve_tool_paths()`/`_find_tool()` checks the bundled `ffmpeg-8.0.1-essentials_build/`/`yt-dlp.exe` next to the repo first, then falls back to `shutil.which(...)` (system PATH) — same two-step lookup as `resolve_tools.ps1` on the PowerShell side, so a fresh checkout works whether or not the bundled ffmpeg folder is present. The Settings modal's path fields are optional overrides only (empty = auto-detect); leave them blank unless forcing a specific install, and always point at the `.exe` itself, not its folder. `Api.check_prereqs()` resolves the real path either way and the modal shows it under each field ("Utilisé : ...") so an override that doesn't actually take effect is visible instead of silently falling back to PATH.
- **yt-dlp needs periodic updates** — YouTube changes frequently enough that a yt-dlp build a few months old routinely starts failing downloads with HTTP 403. `Api.update_yt_dlp()` runs the bundled/resolved binary's own `-U` self-updater; wired to the "Mettre à jour yt-dlp" button in Settings. The download format defaults to `bv*[height<=480]+ba/b[height<=480]` (adaptive video+audio, merged) rather than a bare `best[height<=480]`, since YouTube has mostly stopped serving pre-merged progressive streams above 360p — the old selector now fails outright with "Requested format is not available" on most videos. Both `gui/pipeline/download.py` and `sanitize_video_names.ps1` also pass `--merge-output-format mp4` explicitly: without it, an adaptive-format merge outputs `.webm`, which silently breaks every downstream `*.mp4` glob.
- **`gui/jobs.py`** runs each pipeline stage on a background thread and buffers `{log, progress, done, error, cancelled}` events; the frontend polls `Api.get_job_events` rather than being pushed to — cancellation is cooperative via a `threading.Event` checked inside `gui/pipeline/ffmpeg_utils.py`'s subprocess poll loop (which also does the actual `terminate()`/`kill()`).
- **`gui/api.py`** is the entire `js_api` surface exposed to `gui/web/app.js`. Only one job is expected to run at a time — enforced in the frontend (tabs/buttons disabled while running), not in `JobManager`.
- CSS gotcha to remember if editing `gui/web/style.css`: any element toggled via the `hidden` attribute needs `[hidden] { display: none !important; }` (present near the top of the file) to actually hide, because sibling class rules that set `display` (`.btn`, `.field-row`, `.modal-overlay`) otherwise win the cascade tie. Similarly, the app-shell rows in `body`'s CSS grid are pinned with explicit `grid-row: N` — don't remove those, since without them hiding `#prereqBanner` shifts every row after it into the wrong track.
