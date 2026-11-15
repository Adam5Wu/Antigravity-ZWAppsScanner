<#
.SYNOPSIS
    Installs or updates Antigravity-ZWAppsScanner in Antigravity's global plugins
    directory (`~/.gemini/config/plugins/esp-zw-app-scanner`).

.DESCRIPTION
    By default, copies a complete, self-contained bundle (manifest, assets, skill,
    and sidecar) into `$HOME\.gemini\config\plugins\esp-zw-app-scanner` and stamps
    `sidecar.json` so Antigravity reloads the running sidecar automatically.

    Pass `-LinkSource` during active UI/scanner development in a worktree to point the
    registered sidecar directly at this checkout's `sidecars/scanner/main.mjs`.

    Note: If you cloned this repository directly into `$HOME\.gemini\config\plugins\esp-zw-app-scanner`
    (or `~/.gemini/config/plugins/esp-zw-app-scanner` on macOS/Linux), you do NOT need
    to run this script — Antigravity discovers it automatically.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$PluginDir = (Join-Path $HOME ".gemini\config\plugins\esp-zw-app-scanner"),

    [Parameter(Mandatory = $false)]
    [switch]$LinkSource
)

$ErrorActionPreference = "Stop"

$srcRoot = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$regDir  = [System.IO.Path]::GetFullPath($PluginDir)

if ($srcRoot.TrimEnd('\', '/').Equals($regDir.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "Repository is already located at '$regDir'; no registration copy required." -ForegroundColor Green
    exit 0
}

New-Item -ItemType Directory -Path `
    "$regDir\assets", `
    "$regDir\skills\zw-appliance-scanner", `
    "$regDir\sidecars\scanner" -Force | Out-Null

Copy-Item "$srcRoot\plugin.json" "$regDir\plugin.json" -Force
Copy-Item "$srcRoot\assets\logo.svg" "$regDir\assets\logo.svg" -Force
Copy-Item "$srcRoot\skills\zw-appliance-scanner\SKILL.md" "$regDir\skills\zw-appliance-scanner\SKILL.md" -Force
if (Test-Path "$srcRoot\README.md") {
    Copy-Item "$srcRoot\README.md" "$regDir\README.md" -Force
}

if ($LinkSource) {
    $normSrcRoot = $srcRoot -replace '\\', '/'
    $sidecarArgs = @("$normSrcRoot/sidecars/scanner/main.mjs")
    $sidecarEnv  = [ordered]@{
        ZWAPPS_SCANNER_SYNCED_AT = [DateTime]::UtcNow.ToString("o")
    }
    $targetDesc = "$normSrcRoot/sidecars/scanner/main.mjs (linked)"
}
else {
    foreach ($f in @("package.json", "main.mjs", "scanner.mjs", "index.html", "styles.css", "app.js")) {
        Copy-Item "$srcRoot\sidecars\scanner\$f" "$regDir\sidecars\scanner\$f" -Force
    }
    $sidecarArgs = @("main.mjs")
    $sidecarEnv  = [ordered]@{
        ZWAPPS_SCANNER_SYNCED_AT = [DateTime]::UtcNow.ToString("o")
    }
    $targetDesc = "$regDir\sidecars\scanner\main.mjs (self-contained)"
}

$sidecarObj = [ordered]@{
    command        = "node"
    args           = $sidecarArgs
    restart_policy = "always"
    env            = $sidecarEnv
    display_name   = "ZW Appliances"
    description    = "On-demand subnet scanner and device manager for ESPZWApplianceT2 microcontroller projects."
    has_web_ui     = $true
    ui_config      = [ordered]@{
        display_name = "ZW Appliances"
        views        = @(
            [ordered]@{
                path       = "/"
                entrypoint = "SIDECAR_UI_ENTRYPOINT_AUX_PANE"
                title      = "ZW Appliances"
            }
        )
    }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    "$regDir\sidecars\scanner\sidecar.json",
    ($sidecarObj | ConvertTo-Json -Depth 6),
    $utf8NoBom
)

Write-Host "Registered plugin 'esp-zw-app-scanner' -> $targetDesc" -ForegroundColor Green
