$ErrorActionPreference = 'Stop'
$HostName = 'org.firefox_ip_protection.chrome_bridge'
$ExtensionId = 'dlogjlmofifonkgbcnjalehpmkdmegnd'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Write-Step([string]$Message) { Write-Host "[FirefoxVPN] $Message" }

function Get-RegisteredManifestPaths {
    # Brave keeps its own Native Messaging key; Chrome/Edge/Chromium do not cover it.
    $keys=@("HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName","HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName","HKCU:\Software\Chromium\NativeMessagingHosts\$HostName","HKCU:\Software\BraveSoftware\Brave\NativeMessagingHosts\$HostName")
    $out=@()
    foreach($k in $keys){ if(Test-Path $k){ try{$v=(Get-Item $k).GetValue(''); if($v){$out+=[string]$v}}catch{}} }
    return $out | Select-Object -Unique
}

function Stop-OldHosts([string[]]$paths){
    foreach($p in $paths){
        try{
            if(Test-Path $p){$j=Get-Content $p -Raw | ConvertFrom-Json; $exe=[Environment]::ExpandEnvironmentVariables([string]$j.path)}
            if($exe){Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $exe} | ForEach-Object {Write-Step "Stopping stale native host PID $($_.Id): $exe"; Stop-Process $_.Id -Force}}
        }catch{}
    }
}

try{
 Write-Step 'Repairing Native Messaging registration...'
 $runtimeExe=Join-Path $Root 'runtime\vpn_bridge_host.exe'
 if(-not (Test-Path -LiteralPath $runtimeExe -PathType Leaf)){
   throw 'runtime\vpn_bridge_host.exe was not found. Build the runtime first; see docs\BUILD.md.'
 }
 Stop-OldHosts @(Get-RegisteredManifestPaths)

 $manifestPath=Join-Path (Split-Path $runtimeExe) 'org.firefox_ip_protection.chrome_bridge.json'
 $manifest=[ordered]@{name=$HostName;description='Firefox IP Protection Native Messaging bridge';path=$runtimeExe;type='stdio';allowed_origins=@("chrome-extension://$ExtensionId/")}

 $json=$manifest|ConvertTo-Json -Depth 5
 [IO.File]::WriteAllText($manifestPath,$json,(New-Object Text.UTF8Encoding($false)))
 foreach($key in @("HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName","HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName","HKCU:\Software\Chromium\NativeMessagingHosts\$HostName","HKCU:\Software\BraveSoftware\Brave\NativeMessagingHosts\$HostName")){New-Item $key -Force|Out-Null;Set-Item $key $manifestPath;Write-Step "Registered: $key"}
 Write-Step "Manifest: $manifestPath"
 Write-Step 'Repair complete. Restart browser and reload extension.'
 exit 0
}catch{Write-Host "[FirefoxVPN][ERROR] $($_.Exception.Message)" -ForegroundColor Red;exit 1}
