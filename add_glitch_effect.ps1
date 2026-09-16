# ======== CONFIGURATION ========
. "$PSScriptRoot\resolve_tools.ps1"
$ffmpegPath = $FfmpegPath

# VIDEO D'ENTREE - par defaut la sortie de cut_clips_random.ps1 sous $MixHome (voir resolve_tools.ps1)
$editsFolder = Join-Path $MixHome "edits\Projet_VHS_Glitch_ALL_poids"
$inputVideo = Join-Path $editsFolder "final_mix.mp4"

# VIDEO DE SORTIE
$outputVideo = Get-UniqueOutputPath (Join-Path $editsFolder "final_mix_glitch.mp4")

# ======== EFFET GLITCH LEGER ========
# Combine :
# - Horizontal scan lines (effet VHS)
# - Slight color shift (RGB offset)
# - Random noise
# - Subtle distortion

# noise's alls= is a 0-100 strength, not a 0-1 fraction - 0.05 was next to imperceptible.
$glitchFilter = "scale=1920:1080,fps=30,hue=s=1.2,noise=alls=12:allf=t"

Write-Host "Application de l'effet glitch..."

& $ffmpegPath -i "$inputVideo" `
    -vf "$glitchFilter" `
    -c:v libx264 -preset medium -crf 18 `
    -c:a aac -b:a 192k `
    "$outputVideo"

if (Test-Path $outputVideo) {
    Write-Host "OK - Glitch applique : $outputVideo"
} else {
    Write-Host "ERREUR - Impossible de creer la video"
}