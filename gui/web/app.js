(() => {
  "use strict";

  const state = {
    config: null,
    activeTab: "download",
    jobId: null,
    jobKind: null,
    pollTimer: null,
    sinceSeq: 0,
    saveTimer: null,
    lastGenerateResult: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const START_LABELS = {
    download: "Télécharger",
    generate: "Générer le mix",
    glitch: "Appliquer l'effet",
  };

  function api() {
    return window.pywebview.api;
  }

  // ---------------- init ----------------

  window.addEventListener("pywebviewready", init);

  async function init() {
    wireStaticEvents();
    enhanceAllNumberInputs(document);
    state.config = await api().get_config();
    hydrateForms();
    await refreshPrereqs();
  }

  function wireStaticEvents() {
    $$(".tab").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

    $("#addPlaylistBtn").addEventListener("click", () => {
      state.config.download.playlists.push({ playlistUrl: "", folderName: "" });
      renderPlaylists();
      scheduleSave();
    });
    $("#addFolderBtn").addEventListener("click", () => {
      state.config.generate.sourceFolders.push({ path: "", weight: 0 });
      renderFolders();
      scheduleSave();
    });
    $("#addClipTypeBtn").addEventListener("click", () => {
      state.config.generate.clipTypes.push({ name: "nouveau", beats: 8, probability: 0 });
      renderClipTypes();
      scheduleSave();
    });

    $("#downloadBaseDir").addEventListener("input", (e) => {
      state.config.download.baseDir = e.target.value;
      scheduleSave();
    });
    $("#downloadFormat").addEventListener("input", (e) => {
      state.config.download.format = e.target.value;
      scheduleSave();
    });

    $("#bpmInput").addEventListener("input", (e) => {
      state.config.generate.bpm = Number(e.target.value) || 1;
      renderClipDurations();
      scheduleSave();
    });
    $("#finalDuration").addEventListener("input", bindNumber(["generate", "finalVideoDurationMinutes"]));
    $("#skipStart").addEventListener("input", bindNumber(["generate", "skipStart"]));
    $("#skipEnd").addEventListener("input", bindNumber(["generate", "skipEnd"]));
    $("#genWidth").addEventListener("input", bindNumber(["generate", "width"]));
    $("#genHeight").addEventListener("input", bindNumber(["generate", "height"]));
    $("#genFps").addEventListener("input", bindNumber(["generate", "fps"]));
    $("#editsFolder").addEventListener("input", (e) => {
      state.config.generate.editsFolder = e.target.value;
      scheduleSave();
    });
    $("#outputFileName").addEventListener("input", (e) => {
      state.config.generate.outputFileName = e.target.value;
      scheduleSave();
    });
    $("#datamoshProbability").addEventListener("input", bindNumber(["generate", "datamoshProbability"]));
    $("#datamoshWindow").addEventListener("input", bindNumber(["generate", "datamoshWindow"]));

    $("#effectSelect").addEventListener("change", (e) => {
      state.config.glitch.effect = e.target.value;
      updateGlitchOutputPath();
      scheduleSave();
    });
    $("#glitchInput").addEventListener("input", (e) => {
      state.config.glitch.lastInputVideo = e.target.value;
      updateGlitchOutputPath();
      scheduleSave();
    });
    $("#glitchWidth").addEventListener("input", bindNumber(["glitch", "width"]));
    $("#glitchHeight").addEventListener("input", bindNumber(["glitch", "height"]));
    $("#glitchFps").addEventListener("input", bindNumber(["glitch", "fps"]));

    $$(".browse-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const target = $("#" + btn.dataset.target);
        const kind = btn.dataset.kind;
        const picked = kind === "folder" ? await api().browse_folder(target.value) : await api().browse_file(target.value);
        if (picked) {
          target.value = picked;
          target.dispatchEvent(new Event("input"));
        }
      });
    });

    $("#openGlitchOutputBtn").addEventListener("click", () => {
      api().open_output_folder($("#glitchOutputPath").textContent);
    });

    $("#startBtn").addEventListener("click", onStart);
    $("#cancelBtn").addEventListener("click", onCancel);
    $("#deleteTempBtn").addEventListener("click", onDeleteTempClips);

    $("#settingsBtn").addEventListener("click", openSettings);
    $("#closeSettingsBtn").addEventListener("click", closeSettings);
    $("#saveSettingsBtn").addEventListener("click", saveSettings);
    $("#recheckPrereqsBtn").addEventListener("click", refreshPrereqs);
    $("#updateYtDlpBtn").addEventListener("click", onUpdateYtDlp);

    $$(".settings-browse-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const target = $("#" + btn.dataset.target);
        const picked = await api().browse_file(target.value, ["Exécutable (*.exe)", "Tous les fichiers (*.*)"]);
        if (picked) target.value = picked;
      });
    });

    document.addEventListener("mouseover", (e) => {
      const trigger = e.target.closest(".tooltip");
      if (trigger) positionTooltip(trigger);
    });
  }

  // ---------------- tooltip overflow avoidance ----------------

  function positionTooltip(trigger) {
    trigger.classList.remove("tooltip-below", "tooltip-shift-left", "tooltip-shift-right");

    const container = trigger.closest(".content") || document.body;
    const containerRect = container.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const popupWidth = 260; // keep in sync with .tooltip::after max-width in style.css
    const margin = 12;

    if (triggerRect.top - containerRect.top < 60) {
      trigger.classList.add("tooltip-below");
    }
    if (triggerRect.left + popupWidth / 2 > containerRect.right - margin) {
      trigger.classList.add("tooltip-shift-left");
    } else if (triggerRect.left - popupWidth / 2 < containerRect.left + margin) {
      trigger.classList.add("tooltip-shift-right");
    }
  }

  async function onUpdateYtDlp() {
    const status = $("#updateYtDlpStatus");
    const btn = $("#updateYtDlpBtn");
    btn.disabled = true;
    status.textContent = "Mise à jour en cours…";
    const result = await api().update_yt_dlp();
    btn.disabled = false;
    status.textContent = result.output || (result.ok ? "OK" : "Échec.");
    if (result.ok) await refreshPrereqs();
  }

  function bindNumber(path) {
    return (e) => {
      setPath(state.config, path, Number(e.target.value));
      scheduleSave();
    };
  }

  function setPath(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
    cur[path[path.length - 1]] = value;
  }

  // ---------------- number input steppers ----------------

  function enhanceAllNumberInputs(root) {
    root.querySelectorAll('input[type="number"]').forEach(enhanceNumberInput);
  }

  function enhanceNumberInput(input) {
    if (input.dataset.stepperReady) return;
    input.dataset.stepperReady = "1";

    const wrap = document.createElement("div");
    wrap.className = "number-stepper";
    if (input.classList.contains("row-narrow")) {
      input.classList.remove("row-narrow");
      wrap.classList.add("row-narrow");
    }

    input.parentNode.insertBefore(wrap, input);
    const dec = document.createElement("button");
    dec.type = "button";
    dec.className = "stepper-btn stepper-dec";
    dec.textContent = "–";
    dec.setAttribute("aria-label", "Diminuer");
    wrap.appendChild(dec);
    wrap.appendChild(input);
    const inc = document.createElement("button");
    inc.type = "button";
    inc.className = "stepper-btn stepper-inc";
    inc.textContent = "+";
    inc.setAttribute("aria-label", "Augmenter");
    wrap.appendChild(inc);

    const fire = () => input.dispatchEvent(new Event("input", { bubbles: true }));
    dec.addEventListener("click", () => {
      try { input.stepDown(); } catch { input.value = (Number(input.value) || 0) - (Number(input.step) || 1); }
      fire();
    });
    inc.addEventListener("click", () => {
      try { input.stepUp(); } catch { input.value = (Number(input.value) || 0) + (Number(input.step) || 1); }
      fire();
    });
  }

  function switchTab(tab) {
    state.activeTab = tab;
    $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + tab));
    $("#startBtnLabel").textContent = START_LABELS[tab] || "Démarrer";
  }

  // ---------------- hydrate forms from config ----------------

  function hydrateForms() {
    const c = state.config;
    $("#downloadBaseDir").value = c.download.baseDir;
    $("#downloadFormat").value = c.download.format;
    renderPlaylists();

    $("#bpmInput").value = c.generate.bpm;
    $("#finalDuration").value = c.generate.finalVideoDurationMinutes;
    $("#skipStart").value = c.generate.skipStart;
    $("#skipEnd").value = c.generate.skipEnd;
    $("#genWidth").value = c.generate.width;
    $("#genHeight").value = c.generate.height;
    $("#genFps").value = c.generate.fps;
    $("#editsFolder").value = c.generate.editsFolder;
    $("#outputFileName").value = c.generate.outputFileName;
    $("#datamoshProbability").value = c.generate.datamoshProbability;
    $("#datamoshWindow").value = c.generate.datamoshWindow;
    renderFolders();
    renderClipTypes();

    $("#effectSelect").value = c.glitch.effect;
    $("#glitchInput").value = c.glitch.lastInputVideo || "";
    $("#glitchWidth").value = c.glitch.width;
    $("#glitchHeight").value = c.glitch.height;
    $("#glitchFps").value = c.glitch.fps;
    updateGlitchOutputPath();

    $("#ffmpegPathInput").value = c.paths.ffmpegPath;
    $("#ffprobePathInput").value = c.paths.ffprobePath;
    $("#ytDlpPathInput").value = c.paths.ytDlpPath;
  }

  // ---------------- playlist rows ----------------

  function renderPlaylists() {
    const container = $("#playlistRows");
    container.innerHTML = "";
    const tpl = $("#playlistRowTpl");
    state.config.download.playlists.forEach((entry, index) => {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.querySelector('[data-field="playlistUrl"]').value = entry.playlistUrl || "";
      row.querySelector('[data-field="folderName"]').value = entry.folderName || "";
      row.querySelectorAll("[data-field]").forEach((input) => {
        input.addEventListener("input", () => {
          entry[input.dataset.field] = input.value;
          scheduleSave();
        });
      });
      row.querySelector(".remove-row").addEventListener("click", () => {
        state.config.download.playlists.splice(index, 1);
        renderPlaylists();
        scheduleSave();
      });
      container.appendChild(row);
    });
  }

  // ---------------- source folder rows ----------------

  function renderFolders() {
    const container = $("#folderRows");
    container.innerHTML = "";
    const tpl = $("#folderRowTpl");
    state.config.generate.sourceFolders.forEach((entry, index) => {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.querySelector('[data-field="path"]').value = entry.path || "";
      row.querySelector('[data-field="weight"]').value = Number(entry.weight || 0).toFixed(2);
      row.querySelectorAll("[data-field]").forEach((input) => {
        input.addEventListener("input", () => {
          const val = input.dataset.field === "weight" ? Number(input.value) : input.value;
          entry[input.dataset.field] = val;
          if (input.dataset.field === "weight") updateFolderWeightTotal();
          if (input.dataset.field === "path") scheduleVideoCount(entry.path, row);
          scheduleSave();
        });
      });
      row.querySelector(".browse-row-btn").addEventListener("click", async () => {
        const picked = await api().browse_folder(entry.path);
        if (picked) {
          entry.path = picked;
          row.querySelector('[data-field="path"]').value = picked;
          refreshVideoCount(picked, row);
          scheduleSave();
        }
      });
      row.querySelector(".remove-row").addEventListener("click", () => {
        state.config.generate.sourceFolders.splice(index, 1);
        renderFolders();
        scheduleSave();
      });
      container.appendChild(row);
      enhanceAllNumberInputs(row);
      if (entry.path) refreshVideoCount(entry.path, row);
    });
    updateFolderWeightTotal();
  }

  async function refreshVideoCount(path, row) {
    if (!path) return;
    const counts = await api().list_source_videos([path]);
    const span = row.querySelector("[data-video-count]");
    const n = counts[path] || 0;
    span.textContent = `${n} vidéo${n === 1 ? "" : "s"}`;
  }

  function scheduleVideoCount(path, row) {
    clearTimeout(row._videoCountTimer);
    row._videoCountTimer = setTimeout(() => refreshVideoCount(path, row), 400);
  }

  function updateFolderWeightTotal() {
    const total = state.config.generate.sourceFolders.reduce((s, f) => s + (Number(f.weight) || 0), 0);
    const el = $("#folderWeightTotal");
    el.textContent = `${Math.round(total * 100)}%`;
    el.classList.toggle("off", Math.abs(total - 1) > 0.02);
  }

  // ---------------- clip type rows ----------------

  function renderClipTypes() {
    const container = $("#clipTypeRows");
    container.innerHTML = "";
    const tpl = $("#clipTypeRowTpl");
    state.config.generate.clipTypes.forEach((entry, index) => {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.querySelector('[data-field="name"]').value = entry.name || "";
      row.querySelector('[data-field="beats"]').value = entry.beats;
      row.querySelector('[data-field="probability"]').value = Number(entry.probability || 0).toFixed(2);
      row.querySelectorAll("[data-field]").forEach((input) => {
        input.addEventListener("input", () => {
          const field = input.dataset.field;
          entry[field] = field === "name" ? input.value : Number(input.value);
          if (field === "beats") updateClipDurationCell(entry, row);
          if (field === "probability") updateClipWeightTotal();
          scheduleSave();
        });
      });
      row.querySelector(".remove-row").addEventListener("click", () => {
        state.config.generate.clipTypes.splice(index, 1);
        renderClipTypes();
        scheduleSave();
      });
      container.appendChild(row);
      enhanceAllNumberInputs(row);
      updateClipDurationCell(entry, row);
    });
    updateClipWeightTotal();
  }

  function updateClipDurationCell(entry, row) {
    const bpm = Number(state.config.generate.bpm) || 1;
    const duration = (Number(entry.beats) || 0) * (60 / bpm);
    row.querySelector("[data-clip-duration]").textContent = `${duration.toFixed(2)}s`;
  }

  function renderClipDurations() {
    $$('#clipTypeRows .row').forEach((row, i) => {
      updateClipDurationCell(state.config.generate.clipTypes[i], row);
    });
  }

  function updateClipWeightTotal() {
    const total = state.config.generate.clipTypes.reduce((s, c) => s + (Number(c.probability) || 0), 0);
    const el = $("#clipWeightTotal");
    el.textContent = `${Math.round(total * 100)}%`;
    el.classList.toggle("off", Math.abs(total - 1) > 0.02);
  }

  // ---------------- glitch tab helpers ----------------

  function updateGlitchOutputPath() {
    const input = state.config.glitch.lastInputVideo;
    const effect = state.config.glitch.effect;
    const el = $("#glitchOutputPath");
    if (!input) {
      el.textContent = "—";
      return;
    }
    const suffix = effect === "datamosh" ? "_datamosh" : "_glitch";
    const dot = input.lastIndexOf(".");
    el.textContent = dot > -1 ? input.slice(0, dot) + suffix + input.slice(dot) : input + suffix;
  }

  // ---------------- autosave ----------------

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, 500);
  }

  async function flushSave() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    // Capture which row/field is focused *before* the autosave round-trip: the re-render
    // below rebuilds every row from scratch (cloned from the <template>), which would
    // otherwise silently steal focus mid-edit. If the user clears a field (e.g. a "beats"
    // value) and pauses for the 500ms debounce before typing the replacement, losing focus
    // here means their next keystrokes land nowhere — the field looks stuck at whatever
    // got normalized (0), which is exactly the "can't type a value back in" symptom.
    const focusInfo = captureRowFocus();
    const normalized = await api().save_config(state.config);
    state.config = normalized;
    // Reflect any server-side normalization (e.g. weight rebalancing) back into the UI.
    // Re-render every row-based section — state.config was just replaced wholesale, so any
    // row still bound to the previous object would silently stop receiving further edits.
    renderPlaylists();
    renderFolders();
    renderClipTypes();
    restoreRowFocus(focusInfo);
  }

  function captureRowFocus() {
    const el = document.activeElement;
    if (!el || !el.matches("input, select, textarea")) return null;
    const row = el.closest("[data-row]");
    const container = row ? row.parentElement : null;
    if (!row || !container || !container.id) return null;
    // input[type=number] throws on selectionStart/End access in Chromium (unsupported for
    // that input type) — number is exactly what beats/weight/probability fields use, so this
    // must be guarded rather than feature-detected.
    let selStart = null, selEnd = null;
    try {
      selStart = el.selectionStart;
      selEnd = el.selectionEnd;
    } catch { /* number/date/etc. input — no text selection to preserve */ }
    return {
      containerId: container.id,
      index: Array.from(container.children).indexOf(row),
      field: el.dataset.field || null,
      selStart,
      selEnd,
    };
  }

  function restoreRowFocus(info) {
    if (!info) return;
    const container = document.getElementById(info.containerId);
    const row = container && container.children[info.index];
    if (!row) return;
    const el = info.field ? row.querySelector(`[data-field="${info.field}"]`) : row.querySelector("input, select");
    if (!el) return;
    el.focus();
    if (info.selStart !== null && el.setSelectionRange) {
      try { el.setSelectionRange(info.selStart, info.selEnd); } catch { /* not a text-selectable input type */ }
    }
  }

  // ---------------- settings modal ----------------

  function openSettings() {
    $("#settingsModal").hidden = false;
  }
  function closeSettings() {
    $("#settingsModal").hidden = true;
  }
  async function saveSettings() {
    state.config.paths.ffmpegPath = $("#ffmpegPathInput").value;
    state.config.paths.ffprobePath = $("#ffprobePathInput").value;
    state.config.paths.ytDlpPath = $("#ytDlpPathInput").value;
    state.config = await api().save_config(state.config);
    await refreshPrereqs();
    closeSettings();
  }

  async function refreshPrereqs() {
    const status = await api().check_prereqs();
    setDot("#ffmpegStatus", status.ffmpeg);
    setDot("#ffprobeStatus", status.ffprobe);
    setDot("#ytDlpStatus", status.ytDlp);

    const resolved = status.resolvedPaths || {};
    $("#ffmpegResolved").textContent = "Utilisé : " + (resolved.ffmpeg || "—");
    $("#ffprobeResolved").textContent = "Utilisé : " + (resolved.ffprobe || "—");
    $("#ytDlpResolved").textContent = "Utilisé : " + (resolved.ytDlp || "—");

    const missing = [];
    if (!status.ffmpeg) missing.push("ffmpeg.exe");
    if (!status.ffprobe) missing.push("ffprobe.exe");
    if (!status.ytDlp) missing.push("yt-dlp.exe");

    const banner = $("#prereqBanner");
    if (missing.length) {
      $("#prereqBannerText").textContent = `Introuvable(s) : ${missing.join(", ")} — vérifiez les chemins dans Paramètres.`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  function setDot(sel, ok) {
    const el = $(sel);
    el.classList.toggle("ok", !!ok);
    el.classList.toggle("bad", !ok);
  }

  // ---------------- run bar: start / cancel / poll ----------------

  async function onStart() {
    if (state.jobId) return;
    clearLog();
    setRunning(true);
    $("#deleteTempBtn").parentElement.hidden = true;
    $("#openGlitchOutputBtn").hidden = true;

    try {
      // Make sure the backend has the latest edits before starting — start_* reads the
      // server-side config, not the in-page state, so a pending/never-flushed autosave
      // would otherwise silently run the job against stale (or empty) settings.
      await flushSave();

      let jobId;
      if (state.activeTab === "download") {
        jobId = await api().start_download();
      } else if (state.activeTab === "generate") {
        jobId = await api().start_generate();
      } else {
        const input = $("#glitchInput").value;
        if (!input) {
          appendLog("[ERREUR] Choisissez une vidéo d'entrée.");
          setRunning(false);
          return;
        }
        jobId = await api().start_glitch(input, $("#effectSelect").value);
      }
      state.jobId = jobId;
      state.jobKind = state.activeTab;
      state.sinceSeq = 0;
      pollJob();
    } catch (err) {
      appendLog(`[ERREUR] ${err}`);
      setRunning(false);
    }
  }

  async function onCancel() {
    if (!state.jobId) return;
    await api().cancel_job(state.jobId);
    appendLog("[ANNULATION] Demande d'annulation envoyée…");
  }

  function pollJob() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      const data = await api().get_job_events(state.jobId, state.sinceSeq);
      for (const evt of data.events) {
        state.sinceSeq = Math.max(state.sinceSeq, evt.seq);
        handleEvent(evt);
      }
      if (data.status !== "running") {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        setRunning(false);
        state.jobId = null;
      }
    }, 400);
  }

  function handleEvent(evt) {
    if (evt.type === "log") {
      appendLog(evt.message);
    } else if (evt.type === "progress") {
      setProgress(evt.value, evt.label);
    } else if (evt.type === "done") {
      appendLog("[TERMINE] Job terminé avec succès.");
      setProgress(1, "Terminé");
      onJobDone(evt.result);
    } else if (evt.type === "error") {
      appendLog(`[ERREUR] ${evt.message}`, "error");
    } else if (evt.type === "cancelled") {
      appendLog("[ANNULE] Job annulé.");
    }
  }

  function onJobDone(result) {
    if (!result) return;
    if (state.jobKind === "generate") {
      state.lastGenerateResult = result;
      $("#deleteTempBtn").parentElement.hidden = false;
      appendLog(`[INFO] Sortie : ${result.outputPath} (${result.clipCount} clips)`);
    } else if (state.jobKind === "glitch") {
      $("#glitchOutputPath").textContent = result.outputPath;
      $("#openGlitchOutputBtn").hidden = false;
    } else if (state.jobKind === "download") {
      appendLog(`[INFO] ${result.folders.length} dossier(s) téléchargé(s).`);
    }
  }

  async function onDeleteTempClips() {
    if (!state.lastGenerateResult) return;
    await api().delete_temp_clips(state.lastGenerateResult.clipsFolder, state.lastGenerateResult.concatFile, state.lastGenerateResult.moshFolder || "");
    appendLog("[OK] Clips temporaires supprimés.");
    $("#deleteTempBtn").parentElement.hidden = true;
  }

  function setRunning(running) {
    $("#startBtn").hidden = running;
    $("#cancelBtn").hidden = !running;
    $$(".tab").forEach((b) => (b.disabled = running));
    if (!running) setProgress(0, "");
  }

  function setProgress(value, label) {
    $("#progressFill").style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
    $("#progressLabel").textContent = label || "";
  }

  const ERROR_LINE_RE = /\[ERREUR\]|\bERROR\b/i;

  function appendLog(line, level) {
    const panel = $("#logPanel");
    const isError = level === "error" || ERROR_LINE_RE.test(line);
    const entry = document.createElement("span");
    entry.className = "log-line" + (isError ? " log-error" : "");
    entry.textContent = line + "\n";
    panel.appendChild(entry);
    panel.scrollTop = panel.scrollHeight;
  }

  function clearLog() {
    $("#logPanel").textContent = "";
  }
})();
