# Prepare signed assets for the personal release channel. This script never uploads.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$Minisign = 'minisign.exe',
    [string]$SigningKey = (Join-Path $env:LOCALAPPDATA 'OpenCodexPersonalSigning/personal-windows.minisign.key')
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$config = Get-Content -Raw -LiteralPath (Join-Path $repo 'desktop/src-tauri/tauri.conf.json') | ConvertFrom-Json
$version = [string]$config.version
$assetBase = 'https://github.com/abdomsisn/opencodex/releases/download/personal-windows-updates'
if ($version -notmatch '^\d+\.\d+\.\d+$' -or $config.plugins.updater.endpoints[0] -ne "$assetBase/latest.json") {
    throw 'Invalid personal Windows version or update endpoint'
}
$inputMsi = (Resolve-Path -LiteralPath $Installer).Path
$com = New-Object -ComObject WindowsInstaller.Installer
$db = $com.OpenDatabase($inputMsi, 0)
function Get-MsiProperty([string]$Property) {
    $view = $db.OpenView("SELECT Value FROM Property WHERE Property='$Property'")
    try {
        $null = $view.Execute()
        $record = $view.Fetch()
        if ($null -ne $record) { return [string]$record.StringData(1) }
    } finally { $null = $view.Close() }
}
if ((Get-MsiProperty 'ProductVersion') -ne $version -or (Get-MsiProperty 'ProductName') -ne 'OpenCodex Personal') {
    throw 'The MSI product or version does not match the personal build'
}

$output = New-Item -ItemType Directory -Path $OutputDirectory -Force
$name = "OpenCodex-Personal-$version-windows-x64.msi"
$msi = Join-Path $output.FullName $name
$signature = "$msi.minisig"
if ((Test-Path -LiteralPath $msi) -or (Test-Path -LiteralPath $signature) -or (Test-Path -LiteralPath (Join-Path $output.FullName 'latest.json'))) {
    throw 'Use a fresh output directory for each signed build'
}
Copy-Item -LiteralPath $inputMsi -Destination $msi
$pubBox = [Convert]::FromBase64String($config.plugins.updater.pubkey)
$trustedComment = "timestamp:$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())`tfile:$name`tversion:$version"
$decodedPublic = Join-Path $output.FullName ([Guid]::NewGuid().ToString('N') + '.pub')
try {
    [IO.File]::WriteAllBytes($decodedPublic, $pubBox)
    & $Minisign -S -s $SigningKey -m $msi -x $signature -t $trustedComment
    if ($LASTEXITCODE -ne 0) { throw 'MSI signing failed' }
    & $Minisign -V -p $decodedPublic -m $msi -x $signature -q
    if ($LASTEXITCODE -ne 0) { throw 'MSI signature failed verification against the embedded public key' }
    if ((Get-Content -LiteralPath $signature)[2] -cne "trusted comment: $trustedComment") {
        throw 'Verified signature did not bind the MSI version'
    }
} finally {
    if (Test-Path -LiteralPath $decodedPublic) { Remove-Item -LiteralPath $decodedPublic }
}
$manifest = [ordered]@{
    version = $version
    pub_date = [DateTimeOffset]::UtcNow.ToString('o')
    platforms = @{
        'windows-x86_64' = @{
            url = "$assetBase/$name"
            signature = [Convert]::ToBase64String([IO.File]::ReadAllBytes($signature))
        }
    }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $output.FullName 'latest.json')
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $msi).Hash.ToLowerInvariant()
"$digest  $name" | Set-Content -Encoding utf8 (Join-Path $output.FullName 'SHA256SUMS.txt')
Write-Output "Prepared verified Windows release $version in $($output.FullName)"
