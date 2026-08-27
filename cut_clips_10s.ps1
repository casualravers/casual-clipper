# ======== CONFIGURATION ========
. "$PSScriptRoot\resolve_tools.ps1"
$ffmpegPath = $FfmpegPath
$ffprobePath = $FfprobePath

$finalVideoDuration = 60   # 60 minutes
$editsFolder = Join-Path $MixHome "edits\Clips_10s"

# DOSSIER SOURCE - par defaut sous $MixHome\downloads\... (voir resolve_tools.ps1),
# a adapter au dossier reellement telecharge.
$sourceFolder = Join-Path $MixHome "downloads\Casual_Ravers - ORGANIC"

# Parametres pour eviter intro/outro
$skipStart = 5
$skipEnd = 5

# Resolution et framerate
$width = 1920
$height = 1080
$fps = 30

# Clip duration
$clipDuration = 10

Write-Host "========== CUTS 10 SECONDES RANDOM ==========" -ForegroundColor Cyan
Write-Host "[INFO] Duree cible : $finalVideoDuration minutes"
Write-Host "[INFO] Duree clip : $clipDuration secondes"
Write-Host "[INFO] Skip start : $skipStart secondes"
Write-Host "[INFO] Skip end : $skipEnd secondes"
Write-Host ""

# ======== CREATION DU DOSSIER ========
if (-not (Test-Path $editsFolder)) { 
    New-Item -ItemType Directory -Path $editsFolder | Out-Null
}

$clipsFolder = Join-Path $editsFolder "clips_10s"
if (-not (Test-Path $clipsFolder)) {
    New-Item -ItemType Directory -Path $clipsFolder | Out-Null
}

Write-Host "[OK] Dossiers prepares"

# ======== RECUPERATION DES VIDEOS ========
$sourceVideos = @(Get-ChildItem $sourceFolder -Filter *.mp4 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)

if ($sourceVideos.Count -eq 0) {
    Write-Host "[ERREUR] Aucune video trouvee dans : $sourceFolder" -ForegroundColor Red
    exit
}

Write-Host "[OK] $($sourceVideos.Count) videos trouvees dans : $sourceFolder"
Write-Host ""

# ======== SELECTIONNER ET DECOUPER ========
$cuts = @()
$targetSeconds = $finalVideoDuration * 60
$secondsAccumulated = 0
$clipIndex = 0

Write-Host "[EN COURS] Generation de $finalVideoDuration minutes de contenu..."
Write-Host "(Cela peut prendre 15-25 minutes selon votre CPU)"
Write-Host ""

$startTime = Get-Date
$durationCache = @{}   # video path -> duration, avoids re-probing the same video every time it's picked again

while ($secondsAccumulated -lt $targetSeconds) {
    # Choisir une video ALEATOIREMENT
    $video = $sourceVideos | Get-Random

    if ($secondsAccumulated -ge $targetSeconds) { break }

    # Recuperer infos de la video (avec cache)
    if ($durationCache.ContainsKey($video)) {
        $duration = $durationCache[$video]
    } else {
        $durationOutput = & $ffprobePath -v error -show_entries format=duration -of csv=p=0 "$video"
        if (-not $durationOutput) { continue }
        $duration = [double]$durationOutput
        $durationCache[$video] = $duration
    }
    
    $minViableDuration = $skipStart + $clipDuration + $skipEnd + 1
    
    if ($duration -le $minViableDuration) { continue }
    
    $startMin = $skipStart
    $startMax = [int]($duration - $clipDuration - $skipEnd)
    if ($startMax -le $startMin) { continue }
    
    $start = Get-Random -Minimum $startMin -Maximum $startMax
    
    $clipName = Join-Path $clipsFolder ("clip_{0:D4}.mp4" -f $clipIndex)
    
    if ($clipIndex % 10 -eq 0) {
        $elapsed = (Get-Date) - $startTime
        Write-Host "[DECOUPE] Clip $($clipIndex + 1) - 10s (Progression : $([math]::Round($secondsAccumulated))s / $targetSeconds`s)"
    }
    
    & $ffmpegPath -y -i "$video" `
        -ss $start -t $clipDuration `
        -vf "scale=$width`:$height`:force_original_aspect_ratio=decrease,pad=$width`:$height`:(ow-iw)/2:(oh-ih)/2,fps=$fps" `
        -c:v libx264 -preset ultrafast -crf 23 `
        -an `
        "$clipName" 2>&1 | Out-Null
    
    if (Test-Path $clipName) {
        $cuts += $clipName
        $secondsAccumulated += $clipDuration
        $clipIndex++
    } else {
        Write-Host "  [ERREUR] Clip $clipIndex non cree"
    }
}

if ($cuts.Count -eq 0) {
    Write-Host "[ERREUR] Aucun clip cree" -ForegroundColor Red
    exit
}

Write-Host ""
Write-Host "========== CONCATENATION ==========" -ForegroundColor Cyan
Write-Host "Nombre total de clips : $($cuts.Count)"
Write-Host "Duree accumulee : $([math]::Round($secondsAccumulated / 60, 1)) minutes"
Write-Host ""

# ======== CREER FICHIER CONCAT ========
$concatFile = Join-Path $editsFolder "concat_list.txt"
$utf8NoBOM = New-Object System.Text.UTF8Encoding $false
$stream = [System.IO.StreamWriter]::new($concatFile, $false, $utf8NoBOM)

foreach ($clip in $cuts) {
    $stream.WriteLine("file '$clip'")
}
$stream.Close()

Write-Host "[EN COURS] Concatenation des $($cuts.Count) clips..."
$finalOutput = Get-UniqueOutputPath (Join-Path $editsFolder "final_mix_10s.mp4")

& $ffmpegPath -f concat -safe 0 -i $concatFile -c copy "$finalOutput"

Write-Host ""

if (Test-Path $finalOutput) {
    $finalDuration = & $ffprobePath -v error -show_entries format=duration -of csv=p=0 "$finalOutput"
    $finalDurationSec = [double]$finalDuration
    $finalDurationMin = [math]::Round($finalDurationSec / 60, 1)
    
    Write-Host "[OK] VIDEO CREEE AVEC SUCCES !" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Chemin : $finalOutput" -ForegroundColor Cyan
    Write-Host "  Duree : $finalDurationMin minutes"
    Write-Host "  Clips : $($cuts.Count) x 10s"
    Write-Host "  Framerate : 30fps"
    Write-Host "  Resolution : 1920x1080"
    Write-Host ""
} else {
    Write-Host "[ERREUR] Echec de la creation finale" -ForegroundColor Red
    exit
}

# ======== DATAMOSHING ========
Write-Host "========== DATAMOSHING ==========" -ForegroundColor Cyan
$datamosh = Read-Host "Appliquer le datamoshing ? (o/n)"

if ($datamosh -eq "o") {
    Write-Host ""
    Write-Host "[EN COURS] Application du datamoshing..." -ForegroundColor Yellow
    
    $datamoshOutput = Get-UniqueOutputPath (Join-Path $editsFolder "final_mix_10s_datamosh.mp4")
    
    # Filtre datamosh : corruption frame + blend
    # noise's alls= is a 0-100 strength (not 0-1) and 'difference128' is a harsh flashy blend
    # mode (vs. the previous soft 'lighten' dissolve) - needed for the corruption to actually
    # read as datamoshing instead of a barely-visible crossfade.
    $datamoshFilter = "split=2[orig][dup];[dup]scale=$width`:$height`,eq=contrast=1.6:brightness=0.15:saturation=1.8,rgbashift=rh=6:bh=-6,noise=alls=30:allf=t+u[glitch];[orig][glitch]blend=all_mode=difference128:all_opacity=0.85,eq=contrast=1.4,noise=alls=20:allf=t,fps=$fps"
    
    & $ffmpegPath -i "$finalOutput" `
        -vf "$datamoshFilter" `
        -c:v libx264 -preset medium -crf 20 `
        -an `
        "$datamoshOutput" 2>&1 | Out-Null
    
    if (Test-Path $datamoshOutput) {
        Write-Host "[OK] Datamoshing applique !" -ForegroundColor Green
        Write-Host "  Chemin : $datamoshOutput" -ForegroundColor Cyan
    } else {
        Write-Host "[ERREUR] Datamoshing echoue" -ForegroundColor Red
    }
} else {
    Write-Host "[INFO] Datamoshing ignore"
}

Write-Host ""
Write-Host "========== NETTOYAGE ==========" -ForegroundColor Yellow

$cleanup = Read-Host "Supprimer les fichiers temporaires ? (o/n)"
if ($cleanup -eq "o") {
    Write-Host "[EN COURS] Suppression des clips temporaires..."
    Remove-Item $clipsFolder -Recurse -ErrorAction SilentlyContinue
    Remove-Item $concatFile -ErrorAction SilentlyContinue
    Write-Host "[OK] Fichiers temporaires supprimes" -ForegroundColor Green
} else {
    Write-Host "[INFO] Fichiers conserves dans : $clipsFolder"
}

Write-Host ""
Write-Host "========== TERMINE ==========" -ForegroundColor Green