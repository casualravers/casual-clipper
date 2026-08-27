# ======== CONFIGURATION ========
. "$PSScriptRoot\resolve_tools.ps1"
$ffmpegPath = $FfmpegPath
$ffprobePath = $FfprobePath

$finalVideoDuration = 80   # 80 minutes
$editsFolder = Join-Path $MixHome "edits\Projet_VHS_Glitch_ALL_poids"
$outputFileName = "final_mix.mp4"

# DATAMOSHING - probabilite (0.0 a 1.0) qu'une coupe entre deux clips devienne une
# transition corrompue (bavure/blend + bruit) au lieu d'une coupe franche. 0 = desactive.
$datamoshProbability = 0.0
$datamoshWindow = 0.5   # duree en secondes de la transition corrompue

# DOSSIERS SOURCES AVEC POIDS (0.0 a 1.0) - par defaut sous $MixHome\downloads\...
# (voir resolve_tools.ps1), a adapter aux dossiers reellement telecharges.
# Plus le poids est haut, plus on prend de videos de ce dossier
$downloadsDir = Join-Path $MixHome "downloads"
$sourceFolders = @(
    @{ path = Join-Path $downloadsDir "VHS_Glitch_Bank"; weight = 0.20 },
    @{ path = Join-Path $downloadsDir "Casual_Ravers - CARTOON"; weight = 0.35 },
    @{ path = Join-Path $downloadsDir "Casual_Ravers - GLITCH"; weight = 0.15 },
    @{ path = Join-Path $downloadsDir "Casual_Ravers - RANDOM"; weight = 0.30 }
)

# Parametres pour eviter intro/outro
$skipStart = 5
$skipEnd = 5

# Resolution et framerate
$width = 1920
$height = 1080
$fps = 30

# ======== BPM ET CALCUL ========
$bpm = 150

$beatDuration = 60 / $bpm

$clipTypes = @(
    @{ name = "4beats";   duration = [math]::Round($beatDuration * 4, 2);   probability = 0.2 },
    @{ name = "8beats";   duration = [math]::Round($beatDuration * 8, 2);   probability = 0.35 },
    @{ name = "16beats";  duration = [math]::Round($beatDuration * 16, 2);  probability = 0.3 },
    @{ name = "32beats";  duration = [math]::Round($beatDuration * 32, 2);  probability = 0.15 }
)

Write-Host "[INFO] BPM : $bpm"
Write-Host "[INFO] Duree d'un beat : $([math]::Round($beatDuration, 2))s"
Write-Host "[INFO] Clips generes :"
foreach ($clip in $clipTypes) {
    Write-Host "  - $($clip.name) : $($clip.duration)s ($($clip.probability * 100)%)"
}
Write-Host ""
Write-Host "[INFO] Poids des dossiers :"
foreach ($folder in $sourceFolders) {
    Write-Host "  - $($folder.path) : $($folder.weight * 100)%"
}
Write-Host ""

# ======== CREATION DU DOSSIER ========
if (-not (Test-Path $editsFolder)) { 
    New-Item -ItemType Directory -Path $editsFolder | Out-Null
}

$clipsFolder = Join-Path $editsFolder "clips_normalized"
if (-not (Test-Path $clipsFolder)) {
    New-Item -ItemType Directory -Path $clipsFolder | Out-Null
}

Write-Host "[OK] Dossiers prepares"

# ======== RECUPERATION DES VIDEOS DE TOUS LES DOSSIERS ========
$videosByFolder = @{}

foreach ($folder in $sourceFolders) {
    $folderPath = $folder.path
    if (Test-Path $folderPath) {
        $folderVideos = @(Get-ChildItem $folderPath -Filter *.mp4 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
        $videosByFolder[$folderPath] = $folderVideos
        Write-Host "[OK] $($folderVideos.Count) videos trouvees dans : $folderPath"
    } else {
        Write-Host "[ALERTE] Dossier non trouve : $folderPath"
        $videosByFolder[$folderPath] = @()
    }
}

$totalVideos = 0
foreach ($videos in $videosByFolder.Values) {
    $totalVideos += $videos.Count
}
if ($totalVideos -eq 0) {
    Write-Host "[ERREUR] Aucune video trouvee dans les dossiers"
    exit
}

Write-Host "[OK] $totalVideos videos trouvees au total"
Write-Host ""

# ======== FONCTION POUR CHOISIR UN DOSSIER SELON POIDS ========
function Get-RandomFolder {
    param($sourceFolders, $videosByFolder)
    
    $rand = Get-Random -Minimum 0.0 -Maximum 1.0
    $cumulative = 0
    
    foreach ($folder in $sourceFolders) {
        $cumulative += $folder.weight
        if ($rand -le $cumulative) {
            return $folder.path
        }
    }
    
    return $sourceFolders[-1].path
}

# ======== FONCTION POUR CHOISIR UN TYPE DE CLIP ========
function Get-RandomClipType {
    param($clipTypes)
    
    $rand = Get-Random -Minimum 0.0 -Maximum 1.0
    $cumulative = 0
    
    foreach ($type in $clipTypes) {
        $cumulative += $type.probability
        if ($rand -le $cumulative) {
            return $type
        }
    }
    
    return $clipTypes[-1]
}

# ======== SELECTIONNER ET DECOUPER ========
$cuts = @()
$targetSeconds = $finalVideoDuration * 60
$secondsAccumulated = 0
$clipIndex = 0

Write-Host "[EN COURS] Generation de $finalVideoDuration minutes de contenu..."
Write-Host "(Cela peut prendre 30-45 minutes selon votre CPU)"
Write-Host ""

$startTime = Get-Date
$durationCache = @{}   # video path -> duration, avoids re-probing the same video every time it's picked again

while ($secondsAccumulated -lt $targetSeconds) {
    # Choisir un DOSSIER selon les poids
    $selectedFolder = Get-RandomFolder $sourceFolders $videosByFolder
    $folderVideos = $videosByFolder[$selectedFolder]

    if ($folderVideos.Count -eq 0) { continue }

    # Choisir une video ALEATOIREMENT dans le dossier choisi
    $video = $folderVideos | Get-Random

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
    
    # CHOISIR UN TYPE DE CLIP ALEATOIREMENT
    $selectedType = Get-RandomClipType $clipTypes
    $clipDuration = $selectedType.duration
    
    $minViableDuration = $skipStart + $clipDuration + $skipEnd + 5
    
    if ($duration -le $minViableDuration) { continue }
    
    $startMin = $skipStart
    $startMax = [int]($duration - $clipDuration - $skipEnd)
    if ($startMax -le $startMin) { continue }
    
    $start = Get-Random -Minimum $startMin -Maximum $startMax
    
    $clipName = Join-Path $clipsFolder ("clip_{0:D4}.mp4" -f $clipIndex)
    
    if ($clipIndex % 10 -eq 0) {
        $elapsed = (Get-Date) - $startTime
        Write-Host "[DECOUPE] Clip $($clipIndex + 1) [$($selectedType.name) - $($clipDuration)s] (Progression : $([math]::Round($secondsAccumulated))s / $targetSeconds`s)"
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
    Write-Host "[ERREUR] Aucun clip cree"
    exit
}

# ======== DATAMOSHING ENTRE LES CLIPS ========
$concatList = @($cuts[0])
if ($datamoshProbability -gt 0 -and $cuts.Count -gt 1) {
    $moshFolder = Join-Path $editsFolder "clips_datamosh"
    if (-not (Test-Path $moshFolder)) { New-Item -ItemType Directory -Path $moshFolder | Out-Null }

    $moshCount = 0
    for ($i = 0; $i -lt $cuts.Count - 1; $i++) {
        if ((Get-Random -Minimum 0.0 -Maximum 1.0) -lt $datamoshProbability) {
            $moshPath = Join-Path $moshFolder ("mosh_{0:D4}.mp4" -f $i)
            # noise's alls= is a 0-100 strength (not 0-1) and 'difference128' is a harsh flashy
            # blend mode (vs. a soft 'lighten' dissolve) - both needed for the corruption to
            # actually read as datamoshing instead of a barely-visible crossfade.
            $filterComplex = "[0:v]trim=start=0:duration=$datamoshWindow,setpts=PTS-STARTPTS,eq=contrast=1.6:brightness=0.15:saturation=1.8,rgbashift=rh=6:bh=-6,noise=alls=30:allf=t+u[a];" +
                "[1:v]trim=start=0:duration=$datamoshWindow,setpts=PTS-STARTPTS,eq=contrast=1.6:brightness=0.15:saturation=1.8,rgbashift=rh=-6:bh=6,noise=alls=30:allf=t+u[b];" +
                "[a][b]blend=all_mode=difference128:all_opacity=0.9,eq=contrast=1.4,noise=alls=20:allf=t,fps=$fps[out]"

            & $ffmpegPath -y -sseof "-$datamoshWindow" -i "$($cuts[$i])" -i "$($cuts[$i + 1])" `
                -filter_complex $filterComplex -map "[out]" `
                -c:v libx264 -preset ultrafast -crf 23 -an `
                "$moshPath" 2>&1 | Out-Null

            if (Test-Path $moshPath) {
                $concatList += $moshPath
                $moshCount++
            } else {
                Write-Host "  [ERREUR] Transition datamosh $i non creee"
            }
        }
        $concatList += $cuts[$i + 1]
    }
    if ($moshCount -gt 0) {
        Write-Host "[DATAMOSH] $moshCount transition(s) corrompue(s) inseree(s) entre les clips"
    }
} else {
    $concatList = $cuts
}

Write-Host ""
Write-Host "========== CONCATENATION =========="
Write-Host "Nombre total de segments : $($concatList.Count)"
Write-Host "Duree accumulee : $([math]::Round($secondsAccumulated / 60, 1)) minutes"
Write-Host ""

# ======== CREER FICHIER CONCAT ========
$concatFile = Join-Path $editsFolder "concat_list.txt"
$utf8NoBOM = New-Object System.Text.UTF8Encoding $false
$stream = [System.IO.StreamWriter]::new($concatFile, $false, $utf8NoBOM)

foreach ($clip in $concatList) {
    $stream.WriteLine("file '$clip'")
}
$stream.Close()

Write-Host "[EN COURS] Concatenation des $($cuts.Count) clips..."
$finalOutput = Get-UniqueOutputPath (Join-Path $editsFolder $outputFileName)
if ((Split-Path $finalOutput -Leaf) -ne $outputFileName) {
    Write-Host "[INFO] Le fichier existait deja, sortie renommee : $(Split-Path $finalOutput -Leaf)" -ForegroundColor Yellow
}

& $ffmpegPath -f concat -safe 0 -i $concatFile -c copy "$finalOutput"

Write-Host ""

if (Test-Path $finalOutput) {
    $finalDuration = & $ffprobePath -v error -show_entries format=duration -of csv=p=0 "$finalOutput"
    $finalDurationSec = [double]$finalDuration
    $finalDurationMin = [math]::Round($finalDurationSec / 60, 1)
    
    Write-Host "[OK] VIDEO DE FOND $finalDurationMin MINUTES CREEE AVEC SUCCES !"
    Write-Host ""
    Write-Host "  Chemin : $finalOutput"
    Write-Host "  Duree : $finalDurationMin minutes"
    Write-Host "  Clips : $($cuts.Count)"
    Write-Host "  BPM : $bpm"
    Write-Host "  Style : VHS Glitch Hardbounce"
    Write-Host "  Framerate : 30fps"
    Write-Host "  Resolution : 1920x1080"
    Write-Host ""
    Write-Host "PRET POUR TON SET !"
} else {
    Write-Host "[ERREUR] Echec de la creation finale"
}

Write-Host ""
Write-Host "========== NETTOYAGE =========="

$cleanup = Read-Host "Supprimer les fichiers temporaires ? (o/n)"
if ($cleanup -eq "o") {
    Write-Host "[EN COURS] Suppression des clips temporaires..."
    Remove-Item $clipsFolder -Recurse -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $editsFolder "clips_datamosh") -Recurse -ErrorAction SilentlyContinue
    Remove-Item $concatFile -ErrorAction SilentlyContinue
    Write-Host "[OK] Fichiers temporaires supprimes"
} else {
    Write-Host "[INFO] Fichiers conserves dans : $clipsFolder"
}

Write-Host ""
Write-Host "========== TERMINE =========="