$ErrorActionPreference='Stop'
$campaignRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$fixturePath=Join-Path $campaignRoot '.real-qa-preview/clipper-v1'
[IO.Directory]::CreateDirectory($fixturePath) | Out-Null
$speechPath=Join-Path $fixturePath 'source.wav'
if((Test-Path -LiteralPath $speechPath) -and (Get-Item -LiteralPath $speechPath).Length -lt 128){Remove-Item -LiteralPath $speechPath}
if(-not(Test-Path -LiteralPath $speechPath)){
 $speaker=New-Object -ComObject SAPI.SpVoice
 $stream=New-Object -ComObject SAPI.SpFileStream
 $stream.Open($speechPath,3)
 $speaker.AudioOutputStream=$stream
 $speaker.Rate=0
 $words=@'
An argument must stand on its own merits. Impressive credentials do not turn a weak explanation into a strong one. When we evaluate a claim, the useful question is whether the evidence supports the conclusion. We should listen carefully to the reasoning before deciding whether we agree.
A clear explanation connects each step to the next. If a step is missing, ask the speaker to explain it. This is a practical way to improve a debate without attacking the person. People can disagree respectfully while still examining the same evidence.
Consider two speakers who reach different conclusions. One speaker may have more experience, but experience alone does not answer every question. Compare the explanations, identify the assumptions, and ask what evidence would change either conclusion. This keeps the discussion focused on the argument.
The most useful habit is to separate confidence from support. A confident voice can make an explanation sound persuasive. Careful reasoning shows why a conclusion follows. Judge arguments on their merits, ask clear questions, and keep the complete context when sharing a short clip from a longer conversation.
'@
 [void]$speaker.Speak($words)
 $stream.Close()
 [Runtime.InteropServices.Marshal]::ReleaseComObject($stream) | Out-Null
 [Runtime.InteropServices.Marshal]::ReleaseComObject($speaker) | Out-Null
}
if(-not(Test-Path -LiteralPath (Join-Path $fixturePath 'source.mp4'))){
 & ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=640x360:rate=30' -i $speechPath -shortest -c:v libx264 -preset ultrafast -crf 25 -pix_fmt yuv420p -c:a aac -movflags +faststart (Join-Path $fixturePath 'source.mp4')
 if($LASTEXITCODE -ne 0){throw 'Source fixture encode failed'}
}
& ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'color=c=0x7c3aed:s=160x160' -frames:v 1 (Join-Path $fixturePath 'logo.png')
if($LASTEXITCODE -ne 0){throw 'Logo fixture failed'}
& ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'sine=frequency=220:duration=90' -af 'volume=0.05' (Join-Path $fixturePath 'music.wav')
if($LASTEXITCODE -ne 0){throw 'Music fixture failed'}
Write-Output 'PASS authorized synthetic speech, source video, logo and music fixtures created locally'
