[CmdletBinding()]
param(
    # Skip the ~80 MB Playwright download. Everything except the in-app browser
    # login keeps working; rerun without this switch later to add it.
    [switch]$SkipBrowserLogin,
    # Do not wait for a keypress at the end (used by automated tests).
    [switch]$NoPause
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# One-click installer / repair for the Native Messaging bridge.
#
# It assembles the runtime from this checkout instead of expecting one to exist:
# locates a Python interpreter, copies the bridge, installs the Python packages,
# optionally downloads the Playwright Firefox used by the in-app browser login,
# writes the Native Messaging manifest and registers it for the Chromium family.
#
# Idempotent: running it again repairs or upgrades an existing install.
# ---------------------------------------------------------------------------

$RepoRoot = Split-Path -Parent $PSScriptRoot
$HostName = "org.firefox_ip_protection.chrome_bridge"
$ExtensionId = "dlogjlmofifonkgbcnjalehpmkdmegnd"
$StableRoot = Join-Path $env:LOCALAPPDATA "FirefoxChromeVPNBridge"
$StableRuntime = Join-Path $StableRoot "runtime"
$StablePool = Join-Path $StableRuntime "firefox-ip-protection-pool"
$StablePackages = Join-Path $StableRuntime "packages"
$PlaywrightBrowsersDir = Join-Path $StableRuntime "pw-browsers"
$HostManifest = Join-Path $StableRuntime "$HostName.json"
$PythonFile = Join-Path $StableRuntime "system_python.txt"
$LogFile = Join-Path $StableRoot "install.log"

$SourceHost = Join-Path $RepoRoot "host\native_host.py"
$SourcePool = Join-Path $RepoRoot "vendor\firefox-ip-protection-pool"
$SourceExtension = Join-Path $RepoRoot "extension"

# Bilingual output: the repository documents itself in English, but a Chinese
# Windows install should not have to read an English installer.
$script:UseChinese = ((Get-UICulture).Name -like "zh*")
function T([string]$English, [string]$Chinese) {
    if ($script:UseChinese) { return $Chinese }
    return $English
}

function Write-Step([string]$Text) { Write-Host $Text -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host ("  " + $Text) -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host ("  " + $Text) -ForegroundColor Yellow }
function Fail([string]$Text) { throw $Text }

function Write-Log([string]$Text) {
    try {
        if (-not (Test-Path -LiteralPath $StableRoot)) { New-Item -ItemType Directory -Path $StableRoot -Force | Out-Null }
        Add-Content -LiteralPath $LogFile -Value ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $Text)
    } catch { }
}

function Pause-IfInteractive {
    if (-not $NoPause) { Read-Host (T "Press Enter to exit" "按回车退出") | Out-Null }
}

# --- Locate the frozen bridge ------------------------------------------------
function Find-BridgeExecutable {
    $candidates = @(
        (Join-Path $RepoRoot "runtime\vpn_bridge_host.exe"),
        (Join-Path $RepoRoot "dist\vpn_bridge_host.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

# --- Locate a usable Python --------------------------------------------------
function Test-PythonCandidate([string]$Path, [string]$Minimum) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $reported = (& $Path -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null | Select-Object -Last 1)
        if (-not $reported) { return $null }
        $reported = $reported.Trim()
        if ([version]$reported -lt [version]$Minimum) { return $null }
        return (Resolve-Path -LiteralPath $Path).Path
    } catch { return $null }
}

function Find-Python {
    $candidates = New-Object System.Collections.Generic.List[string]

    if (Test-Path -LiteralPath $PythonFile) {
        $recorded = (Get-Content -LiteralPath $PythonFile -Raw -ErrorAction SilentlyContinue)
        if ($recorded) { [void]$candidates.Add($recorded.Trim()) }
    }

    # The `py` launcher is the most reliable way to find a specific version.
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        foreach ($version in @("-3.14", "-3.13", "-3.12", "-3")) {
            try {
                $found = & $launcher.Source $version -c "import sys; print(sys.executable)" 2>$null
                foreach ($item in $found) {
                    if ($item -and (Test-Path -LiteralPath $item.Trim())) { [void]$candidates.Add($item.Trim()) }
                }
            } catch { }
        }
    }

    foreach ($name in @("python.exe", "python3.exe")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { [void]$candidates.Add($command.Source) }
    }

    foreach ($root in @($env:LOCALAPPDATA + "\Programs\Python", $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $root) { continue }
        foreach ($version in @("Python314", "Python313", "Python312", "Python311", "Python310")) {
            [void]$candidates.Add((Join-Path $root "$version\python.exe"))
        }
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        $resolved = Test-PythonCandidate $candidate "3.9"
        if ($resolved) { return $resolved }
    }
    return $null
}

function Install-PythonWithWinget {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { return $null }
    Write-Step (T "  Python was not found. Installing it with winget..." "  未找到 Python，正在用 winget 安装...")
    try {
        & $winget.Source install --id Python.Python.3.14 --scope user --silent `
            --accept-package-agreements --accept-source-agreements 2>&1 | Out-String | Write-Log
    } catch {
        Write-Log ("winget failed: " + $_.Exception.Message)
        return $null
    }
    return (Find-Python)
}

function Copy-PoolFiles {
    # The pool is a vendored upstream tree. Copy the modules the bridge invokes
    # plus the licence and notices, and never the per-user state directories:
    # tokens, logs, data and export belong to the running install, not the source.
    New-Item -ItemType Directory -Path $StablePool -Force | Out-Null
    $files = @(
        "ipp_pool.py", "refresh_tokens.py", "refresh_state.py", "renewal_credentials.py",
        "import_credentials.py", "login_and_bootstrap.py", "fcntl.py",
        "requirements.txt", "requirements-bootstrap.txt", "LICENSE", "NOTICE.md"
    )
    foreach ($name in $files) {
        $source = Join-Path $SourcePool $name
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $StablePool $name) -Force
        }
    }
    foreach ($required in @("ipp_pool.py", "refresh_tokens.py")) {
        if (-not (Test-Path -LiteralPath (Join-Path $StablePool $required))) {
            Fail (T "The source tree is missing vendor\firefox-ip-protection-pool\$required" "源码树缺少 vendor\firefox-ip-protection-pool\$required")
        }
    }
}

function Invoke-Pip([string]$PythonPath, [string[]]$Arguments) {
    $output = & $PythonPath @Arguments 2>&1 | Out-String
    Write-Log ("pip " + ($Arguments -join " ") + "`n" + $output)
    return $LASTEXITCODE
}

# ===========================================================================
Write-Host ""
Write-Host (T "Firefox IP Protection Bridge - setup" "Firefox IP 保护桥接 - 安装程序") -ForegroundColor White
Write-Host ("=" * 46) -ForegroundColor DarkGray
Write-Host ""

$exitCode = 0
try {
    if (-not (Test-Path -LiteralPath $SourceHost -PathType Leaf)) {
        Fail (T "Run this from the repository: host\native_host.py was not found." "请在仓库目录内运行：未找到 host\native_host.py。")
    }

    # --- 1. the bridge executable -----------------------------------------
    Write-Step (T "[1/6] Locating the bridge executable" "[1/6] 查找桥接程序")
    $bridgeExe = Find-BridgeExecutable
    if (-not $bridgeExe) {
        Fail (T @"
No vpn_bridge_host.exe was found.

Chrome starts a native host by executable path and cannot run a .py file, so the
bridge has to be frozen first. Either:
  * download it from this project's Releases page (build-bridge.yml attaches it), or
  * build it:  python -m PyInstaller --noconfirm --clean --distpath dist --workpath build tools/bridge-rebuild/vpn_bridge_host.spec
"@ @"
未找到 vpn_bridge_host.exe。

Chrome 按可执行文件路径启动本地宿主，无法直接运行 .py 文件，所以桥接必须先冻结成 exe。请二选一：
  * 从本项目的 Releases 页面下载（build-bridge.yml 会附上），或
  * 自行构建：python -m PyInstaller --noconfirm --clean --distpath dist --workpath build tools/bridge-rebuild/vpn_bridge_host.spec
"@)
    }
    Write-Ok $bridgeExe

    # --- 2. Python --------------------------------------------------------
    Write-Step (T "[2/6] Locating Python (3.9 or newer)" "[2/6] 查找 Python（3.9 或更新）")
    $pythonPath = Find-Python
    if (-not $pythonPath) { $pythonPath = Install-PythonWithWinget }
    if (-not $pythonPath) {
        Fail (T @"
Python 3.9 or newer was not found, and winget could not install it.

Install Python from https://www.python.org/downloads/ (tick "Add python.exe to
PATH" during setup), then run this script again.
"@ @"
未找到 Python 3.9 或更新版本，且 winget 安装失败。

请从 https://www.python.org/downloads/ 安装 Python（安装时勾选
"Add python.exe to PATH"），然后重新运行本脚本。
"@)
    }
    Write-Ok $pythonPath

    # --- 3. copy the runtime ---------------------------------------------
    Write-Step (T "[3/6] Preparing the runtime" "[3/6] 准备运行时")
    New-Item -ItemType Directory -Path $StableRuntime -Force | Out-Null
    Get-Process -Name vpn_bridge_host -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400

    Copy-Item -LiteralPath $bridgeExe -Destination (Join-Path $StableRuntime "vpn_bridge_host.exe") -Force
    Copy-Item -LiteralPath $SourceHost -Destination (Join-Path $StableRuntime "native_host.py") -Force
    Copy-PoolFiles

    # bridge-build.json records which source the executable was frozen from. If a
    # manifest travelled with the executable, honour it: a rebuilt native_host.py
    # paired with a stale executable is exactly the failure this file exists to
    # catch, and it otherwise shows up as baffling runtime behaviour. When there
    # is no manifest (a plain local PyInstaller run), derive one from the files at
    # hand so the installed runtime still describes itself.
    $sourceHash = (Get-FileHash -LiteralPath $SourceHost -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestPath = $null
    foreach ($candidate in @(
        (Join-Path (Split-Path -Parent $bridgeExe) "bridge-build.json"),
        (Join-Path $RepoRoot "runtime\bridge-build.json")
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $manifestPath = $candidate; break }
    }
    if ($manifestPath) {
        $recorded = $null
        try { $recorded = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { $recorded = $null }
        if ($recorded -and $recorded.sourceSha256 -and ($recorded.sourceSha256.ToLowerInvariant() -ne $sourceHash)) {
            Fail (T @"
The executable does not match host\native_host.py.

$(Split-Path -Leaf $manifestPath) was built from a different revision of the source, so
the frozen bridge and the source tree disagree. Rebuild it:
  python -m PyInstaller --noconfirm --clean --distpath dist --workpath build tools/bridge-rebuild/vpn_bridge_host.spec
  python scripts/write_bridge_build_manifest.py dist/vpn_bridge_host.exe --out dist/bridge-build.json
"@ @"
可执行文件与 host\native_host.py 不匹配。

$(Split-Path -Leaf $manifestPath) 是基于另一版源码构建的，冻结的桥接与源码树不一致。请重新构建：
  python -m PyInstaller --noconfirm --clean --distpath dist --workpath build tools/bridge-rebuild/vpn_bridge_host.spec
  python scripts/write_bridge_build_manifest.py dist/vpn_bridge_host.exe --out dist/bridge-build.json
"@)
        }
    }

    $sourceVersion = "unknown"
    $versionMatch = Select-String -LiteralPath $SourceHost -Pattern '^BRIDGE_VERSION\s*=\s*"([^"]+)"' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($versionMatch) { $sourceVersion = $versionMatch.Matches[0].Groups[1].Value }
    $buildManifest = [ordered]@{
        bridgeVersion    = $sourceVersion
        source           = "native_host.py"
        sourceSha256     = $sourceHash
        executable       = "vpn_bridge_host.exe"
        executableSha256 = (Get-FileHash -LiteralPath (Join-Path $StableRuntime "vpn_bridge_host.exe") -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    [IO.File]::WriteAllText(
        (Join-Path $StableRuntime "bridge-build.json"),
        ($buildManifest | ConvertTo-Json -Depth 5),
        (New-Object Text.UTF8Encoding($false))
    )
    Write-Ok $StableRuntime

    # --- 4. Python packages ----------------------------------------------
    Write-Step (T "[4/6] Installing Python packages" "[4/6] 安装 Python 依赖")
    New-Item -ItemType Directory -Path $StablePackages -Force | Out-Null
    $baseExit = Invoke-Pip $pythonPath @(
        "-m", "pip", "install", "--target", $StablePackages, "--upgrade", "--disable-pip-version-check",
        "-r", (Join-Path $StablePool "requirements.txt")
    )
    if ($baseExit -ne 0) {
        # A release bundle may already ship packages\, and an offline machine
        # cannot reach PyPI at all. Only fail when the packages really are absent.
        if (Test-Path -LiteralPath (Join-Path $StablePackages "fxa")) {
            Write-Warn2 (T "pip could not reach the package index; the bundled packages are already in place, continuing." "pip 无法访问包索引；已有随包附带的依赖，继续安装。")
        } else {
            Fail (T "pip failed to install the runtime packages. See install.log for the full output." "pip 安装运行时依赖失败，详见 install.log。")
        }
    }
    Write-Ok (T "runtime packages installed" "运行时依赖已安装")

    # --- 5. optional browser-login component ------------------------------
    $bootstrapReady = $false
    Write-Step (T "[5/6] Browser-login component (about 80 MB)" "[5/6] 浏览器登录组件（约 80 MB）")
    if ($SkipBrowserLogin) {
        Write-Warn2 (T "skipped by request; rerun without -SkipBrowserLogin to add it" "已按参数跳过；去掉 -SkipBrowserLogin 重跑即可补装")
    } else {
        try {
            $bootExit = Invoke-Pip $pythonPath @(
                "-m", "pip", "install", "--target", $StablePackages, "--upgrade", "--disable-pip-version-check",
                "-r", (Join-Path $StablePool "requirements-bootstrap.txt")
            )
            if ($bootExit -eq 0) {
                # pip --target installs are not on sys.path, so the playwright CLI
                # needs PYTHONPATH pointed at the packages directory. The browser
                # is pinned inside the runtime so removing the runtime removes it.
                $env:PYTHONPATH = $StablePackages
                $env:PLAYWRIGHT_BROWSERS_PATH = $PlaywrightBrowsersDir
                & $pythonPath -m playwright install firefox 2>&1 | Out-String | Write-Log
                Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
                Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath (Join-Path $StablePackages "playwright")) { $bootstrapReady = $true }
            }
        } catch {
            Write-Log ("browser-login component failed: " + $_.Exception.Message)
        }
        if ($bootstrapReady) {
            Write-Ok (T "installed; the in-app browser login is available" "已安装；可使用弹窗内的浏览器登录")
        } else {
            Write-Warn2 (T "not installed. Everything else works; only the browser-login button is unavailable." "未安装成功。其他功能不受影响，仅弹窗内的浏览器登录不可用。")
        }
    }

    # --- 6. register ------------------------------------------------------
    Write-Step (T "[6/6] Registering the native host" "[6/6] 注册本地宿主")
    [IO.File]::WriteAllText($PythonFile, $pythonPath + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))

    $manifestObject = [ordered]@{
        name        = $HostName
        description = "Firefox IP Protection Native Messaging bridge"
        path        = [IO.Path]::GetFullPath((Join-Path $StableRuntime "vpn_bridge_host.exe"))
        type        = "stdio"
        allowed_origins = @("chrome-extension://$ExtensionId/")
    }
    $manifestJson = $manifestObject | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($HostManifest, $manifestJson, (New-Object Text.UTF8Encoding($false)))

    $registryKeys = @(
        "HKCU\Software\Google\Chrome\NativeMessagingHosts\$HostName",
        "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
        "HKCU\Software\Chromium\NativeMessagingHosts\$HostName",
        "HKCU\Software\BraveSoftware\Brave\NativeMessagingHosts\$HostName"
    )
    foreach ($key in $registryKeys) {
        & reg.exe add $key /ve /t REG_SZ /d $HostManifest /f | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail (T "Failed to register $key" "注册失败：$key") }
    }
    Write-Ok (T "Chrome, Edge, Chromium and Brave" "Chrome、Edge、Chromium、Brave")

    # --- summary ----------------------------------------------------------
    Write-Host ""
    Write-Host (T "Setup complete." "安装完成。") -ForegroundColor Green
    Write-Host ""
    Write-Host (T "One step is left, because Chrome does not allow it to be automated:" "还剩一步，Chrome 不允许自动化完成：")
    Write-Host (T "  1. Open chrome://extensions" "  1. 打开 chrome://extensions")
    Write-Host (T "  2. Turn on Developer mode (top right)" "  2. 打开右上角的“开发者模式”")
    Write-Host (T "  3. Click Load unpacked and select:" "  3. 点击“加载已解压的扩展程序”，选择：")
    Write-Host ("     " + $SourceExtension) -ForegroundColor White
    Write-Host ""
    Write-Host (T "Then open the popup, expand Settings, and click Sign in via browser." "然后打开弹窗，展开“设置”，点击“浏览器登录”。")
    Write-Host ""
    Write-Host (T "Already had the extension loaded? Reload it in chrome://extensions." "扩展之前已加载？在 chrome://extensions 里点一次“重新加载”。")
    if (-not $bootstrapReady -and -not $SkipBrowserLogin) {
        Write-Host (T "Browser login is unavailable; rerun this script to retry that step." "浏览器登录不可用；重跑本脚本可重试该步骤。")
    }
    Write-Host ("Log: " + $LogFile) -ForegroundColor DarkGray
} catch {
    Write-Host ""
    Write-Host ((T "Setup failed: " "安装失败：") + $_.Exception.Message) -ForegroundColor Red
    Write-Log ("ERROR: " + $_.Exception.Message)
    $exitCode = 1
}

Write-Host ""
Pause-IfInteractive
exit $exitCode
