[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Executable,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$')]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$ArchiveDirectory,

  [string]$GithubOutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Find-WindowsTool {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string[]]$SearchPatterns
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return $command.Path
  }

  foreach ($pattern in $SearchPatterns) {
    $candidate = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($null -ne $candidate) {
      return $candidate.FullName
    }
  }
  throw "Required Windows build tool was not found: $Name"
}

function Test-ByteTextContains {
  param(
    [Parameter(Mandatory = $true)]
    [byte[]]$Bytes,

    [Parameter(Mandatory = $true)]
    [string]$Needle
  )

  $ascii = [Text.Encoding]::ASCII.GetString($Bytes)
  $utf16 = [Text.Encoding]::Unicode.GetString($Bytes)
  return (
    $ascii.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $utf16.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
  )
}

function Convert-RegistryValueForSnapshot {
  param([AllowNull()][object]$Value)

  if ($null -eq $Value) {
    return $null
  }
  if ($Value -is [byte[]]) {
    return [Convert]::ToBase64String($Value)
  }
  if ($Value -is [string[]]) {
    return @($Value)
  }
  return $Value.ToString()
}

function Get-RegistryKeySnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [Microsoft.Win32.RegistryKey]$Hive,

    [Parameter(Mandatory = $true)]
    [string]$SubKey
  )

  $key = $Hive.OpenSubKey($SubKey, $false)
  if ($null -eq $key) {
    return [ordered]@{ Exists = $false }
  }

  try {
    $values = [ordered]@{}
    foreach ($valueName in @($key.GetValueNames() | Sort-Object)) {
      $rawValue = $key.GetValue(
        $valueName,
        $null,
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
      )
      $values[$valueName] = [ordered]@{
        Kind = $key.GetValueKind($valueName).ToString()
        Data = Convert-RegistryValueForSnapshot -Value $rawValue
      }
    }

    $children = [ordered]@{}
    foreach ($childName in @($key.GetSubKeyNames() | Sort-Object)) {
      $children[$childName] = Get-RegistryKeySnapshot `
        -Hive $Hive `
        -SubKey "$SubKey\$childName"
    }
    return [ordered]@{
      Exists = $true
      Values = $values
      Children = $children
    }
  } finally {
    $key.Dispose()
  }
}

function Get-LeafMarkRegistrySnapshot {
  $targets = @(
    'Software\LeafMark',
    'Software\Classes\LeafMark.Markdown',
    'Software\Classes\Applications\LeafMark.exe',
    'Software\Classes\.md\OpenWithList\LeafMark.exe',
    'Software\Classes\.md\OpenWithProgids',
    'Software\Classes\.markdown\OpenWithList\LeafMark.exe',
    'Software\Classes\.markdown\OpenWithProgids',
    'Software\Microsoft\Windows\CurrentVersion\App Paths\LeafMark.exe',
    'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md',
    'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown',
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\LeafMark',
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\com.leafmark.desktop'
  )
  $snapshot = [ordered]@{}
  foreach ($target in $targets) {
    $snapshot[$target] = Get-RegistryKeySnapshot `
      -Hive ([Microsoft.Win32.Registry]::CurrentUser) `
      -SubKey $target
  }

  $registeredApps = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(
    'Software\RegisteredApplications',
    $false
  )
  try {
    $snapshot['RegisteredApplications::LeafMark'] = if ($null -eq $registeredApps) {
      $null
    } else {
      $registeredAppValue = $registeredApps.GetValue('LeafMark', $null)
      Convert-RegistryValueForSnapshot -Value $registeredAppValue
    }
  } finally {
    if ($null -ne $registeredApps) {
      $registeredApps.Dispose()
    }
  }
  return ($snapshot | ConvertTo-Json -Depth 40 -Compress)
}

function Get-DescendantProcesses {
  param([Parameter(Mandatory = $true)][int]$RootProcessId)

  $all = @(Get-CimInstance Win32_Process)
  $knownIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$knownIds.Add($RootProcessId)
  $descendants = [System.Collections.Generic.List[object]]::new()
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($candidate in $all) {
      if (
        $knownIds.Contains([int]$candidate.ParentProcessId) -and
        -not $knownIds.Contains([int]$candidate.ProcessId)
      ) {
        [void]$knownIds.Add([int]$candidate.ProcessId)
        $descendants.Add($candidate)
        $changed = $true
      }
    }
  }
  return @($descendants)
}

function Assert-NoForbiddenProcessStart {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceIdentifier,

    [Parameter(Mandatory = $true)]
    [System.Collections.Generic.HashSet[int]]$KnownProcessIds,

    [Parameter(Mandatory = $true)]
    [string[]]$ForbiddenNames
  )

  $events = @(Get-Event -SourceIdentifier $SourceIdentifier -ErrorAction SilentlyContinue)
  foreach ($eventRecord in $events) {
    try {
      $started = $eventRecord.SourceEventArgs.NewEvent
      $parentId = [int]$started.ParentProcessID
      $startedId = [int]$started.ProcessID
      if ($KnownProcessIds.Contains($parentId)) {
        [void]$KnownProcessIds.Add($startedId)
        $startedName = [IO.Path]::GetFileNameWithoutExtension(
          [string]$started.ProcessName
        ).ToLowerInvariant()
        if ($ForbiddenNames -contains $startedName) {
          throw "Forbidden terminal/browser process started: $($started.ProcessName) (PID $startedId)"
        }
      }
    } finally {
      Remove-Event -EventIdentifier $eventRecord.EventIdentifier -ErrorAction SilentlyContinue
    }
  }
}

$resolvedExecutable = (Resolve-Path $Executable).Path
$resolvedArchiveDirectory = (Resolve-Path $ArchiveDirectory).Path
$executableInfo = Get-Item $resolvedExecutable
if ($executableInfo.Length -gt 35MB) {
  throw "Native compatibility executable exceeds the 35 MiB limit: $($executableInfo.Length) bytes"
}

# Validate the PE header directly so this assertion does not depend on localized tool output.
$bytes = [IO.File]::ReadAllBytes($resolvedExecutable)
if ($bytes.Length -lt 512 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
  throw 'Native compatibility executable is not a valid MZ/PE file.'
}
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
if (
  $peOffset -lt 0 -or
  $peOffset + 256 -ge $bytes.Length -or
  [Text.Encoding]::ASCII.GetString($bytes, $peOffset, 4) -ne "PE`0`0"
) {
  throw 'Native compatibility executable has an invalid PE header.'
}
$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
$optionalMagic = [BitConverter]::ToUInt16($bytes, $peOffset + 24)
$subsystem = [BitConverter]::ToUInt16($bytes, $peOffset + 24 + 68)
if ($machine -ne 0x8664) {
  throw "Native compatibility executable is not x64: 0x$($machine.ToString('x4'))"
}
if ($optionalMagic -ne 0x20b) {
  throw "Native compatibility executable is not PE32+: 0x$($optionalMagic.ToString('x4'))"
}
if ($subsystem -ne 2) {
  throw "Native compatibility executable is not a Windows GUI subsystem binary: $subsystem"
}

$programFilesX86 = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::ProgramFilesX86
)
$programFiles = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::ProgramFiles
)
$dumpbin = Find-WindowsTool -Name 'dumpbin.exe' -SearchPatterns @(
  "$programFiles\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe",
  "$programFilesX86\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe"
)
$imports = (& $dumpbin /nologo /imports $resolvedExecutable 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw "dumpbin failed while inspecting imports.`n$imports"
}
$forbiddenWebImports = @(
  'WebView2Loader.dll',
  'CreateCoreWebView2Environment',
  'libcef.dll',
  'CefInitialize',
  'chrome_elf.dll',
  'ShellExecuteA',
  'ShellExecuteW',
  'CreateProcessA',
  'CreateProcessW',
  'WinExec'
)
$forbiddenRuntimeImports = @(
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'msvcp140.dll',
  'opengl32.dll',
  'd3d12.dll',
  'vulkan-1.dll',
  'RegCreateKey',
  'RegSetValue',
  'RegDeleteKey',
  'RegDeleteValue',
  'RegLoadKey',
  'RegRestoreKey',
  'RegReplaceKey'
)
foreach ($forbiddenImport in $forbiddenWebImports) {
  if ($imports.IndexOf($forbiddenImport, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    throw "Forbidden embedded-web/browser import: $forbiddenImport"
  }
}
foreach ($forbiddenImport in $forbiddenRuntimeImports) {
  if ($imports.IndexOf($forbiddenImport, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    throw "Forbidden compatibility-build import: $forbiddenImport"
  }
}

$forbiddenBinaryMarkers = @(
  'msedgewebview2',
  'CreateCoreWebView2Environment',
  'WebView2Loader',
  '__TAURI_INTERNALS__',
  'tauri://',
  'wry::webview',
  'libcef',
  'CefInitialize',
  'chrome_elf',
  'resources.pak',
  'icudtl.dat',
  '<!doctype html',
  '<div id="root"',
  '<div id="app"',
  '/index.html',
  'vite/client',
  'webpackJsonp'
)
foreach ($marker in $forbiddenBinaryMarkers) {
  if (Test-ByteTextContains -Bytes $bytes -Needle $marker) {
    throw "Forbidden embedded-web/browser-frontend marker: $marker"
  }
}

$mt = Find-WindowsTool -Name 'mt.exe' -SearchPatterns @(
  "$programFilesX86\Windows Kits\*\bin\*\x64\mt.exe",
  "$programFiles\Windows Kits\*\bin\*\x64\mt.exe"
)
$manifestPath = Join-Path $env:RUNNER_TEMP 'LeafMark-native-compat.manifest.xml'
$inputResource = "-inputresource:$resolvedExecutable;#1"
& $mt -nologo $inputResource "-out:$manifestPath"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $manifestPath)) {
  throw 'Failed to extract RT_MANIFEST from the native compatibility executable.'
}
[xml]$manifest = Get-Content $manifestPath -Raw
$assemblyIdentities = @($manifest.SelectNodes(
  "/*[local-name()='assembly']/*[local-name()='assemblyIdentity']"
))
if ($assemblyIdentities.Count -ne 1) {
  throw 'Executable must contain exactly one top-level assemblyIdentity.'
}
if (
  $assemblyIdentities[0].GetAttribute('name') -ne 'LeafMark.NativeCompat' -or
  $assemblyIdentities[0].GetAttribute('processorArchitecture') -ne 'amd64'
) {
  throw 'Executable assemblyIdentity must be LeafMark.NativeCompat for amd64.'
}
$Version -match '^(\d+)\.(\d+)\.(\d+)' | Out-Null
$expectedManifestVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
if ($assemblyIdentities[0].GetAttribute('version') -ne $expectedManifestVersion) {
  throw "Executable manifest version must be $expectedManifestVersion."
}
$executionLevels = @($manifest.SelectNodes("//*[local-name()='requestedExecutionLevel']"))
if ($executionLevels.Count -ne 1) {
  throw 'Executable must contain exactly one requestedExecutionLevel.'
}
if (
  $executionLevels[0].GetAttribute('level') -ne 'asInvoker' -or
  $executionLevels[0].GetAttribute('uiAccess') -ne 'false'
) {
  throw 'Executable must request asInvoker with uiAccess=false.'
}

$registryBefore = Get-LeafMarkRegistrySnapshot
$smokeDirectory = Join-Path $env:RUNNER_TEMP 'LeafMark 原生兼容 启动审计'
New-Item -ItemType Directory -Path $smokeDirectory -Force | Out-Null
$smokeMarkdownPath = Join-Path $smokeDirectory '带 空格的文档.md'
[IO.File]::WriteAllText(
  $smokeMarkdownPath,
  "# LeafMark 原生兼容启动测试`r`n`r`n这是一份 UTF-8 文档。",
  [Text.UTF8Encoding]::new($false)
)
$process = $null
$processTraceSource = "LeafMarkNativeCompat-$PID-$([Guid]::NewGuid().ToString('N'))"
$knownRuntimeProcessIds = [System.Collections.Generic.HashSet[int]]::new()
$forbiddenProcessNames = @(
  'cmd', 'conhost', 'powershell', 'pwsh', 'wt', 'windowsterminal',
  'msedge', 'msedgewebview2', 'chrome', 'chromium', 'firefox',
  'brave', 'opera', 'iexplore', 'electron'
)
Register-CimIndicationEvent `
  -ClassName Win32_ProcessStartTrace `
  -SourceIdentifier $processTraceSource | Out-Null
try {
  $process = Start-Process `
    -FilePath $resolvedExecutable `
    -ArgumentList @("`"$smokeMarkdownPath`"") `
    -PassThru
  [void]$knownRuntimeProcessIds.Add($process.Id)
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $windowReady = $false
  do {
    Start-Sleep -Milliseconds 250
    Assert-NoForbiddenProcessStart `
      -SourceIdentifier $processTraceSource `
      -KnownProcessIds $knownRuntimeProcessIds `
      -ForbiddenNames $forbiddenProcessNames
    $process.Refresh()
    if ($process.HasExited) {
      throw "Executable exited during startup smoke test: $($process.ExitCode)"
    }
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
      $windowReady = $true
      break
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $windowReady) {
    throw 'Executable did not create a native top-level window within 30 seconds.'
  }

  $settleDeadline = [DateTime]::UtcNow.AddSeconds(3)
  do {
    Start-Sleep -Milliseconds 250
    Assert-NoForbiddenProcessStart `
      -SourceIdentifier $processTraceSource `
      -KnownProcessIds $knownRuntimeProcessIds `
      -ForbiddenNames $forbiddenProcessNames
    $process.Refresh()
    if ($process.HasExited) {
      throw "Executable exited during runtime smoke test: $($process.ExitCode)"
    }
  } while ([DateTime]::UtcNow -lt $settleDeadline)

  $descendants = @(Get-DescendantProcesses -RootProcessId $process.Id)
  foreach ($child in $descendants) {
    $childName = [IO.Path]::GetFileNameWithoutExtension([string]$child.Name)
    if ($forbiddenProcessNames -contains $childName.ToLowerInvariant()) {
      throw "Forbidden terminal/browser child process: $($child.Name) (PID $($child.ProcessId))"
    }
  }

  $process.Refresh()
  try {
    $moduleNames = @($process.Modules | ForEach-Object {
      $_.ModuleName.ToLowerInvariant()
    })
  } catch {
    throw "Unable to audit loaded modules: $($_.Exception.Message)"
  }
  foreach ($forbiddenModule in @(
    'webview2loader.dll', 'msedgewebview2.exe', 'libcef.dll',
    'chrome_elf.dll', 'electron.exe'
  )) {
    if ($moduleNames -contains $forbiddenModule) {
      throw "Forbidden embedded browser module loaded: $forbiddenModule"
    }
  }

  $auditedProcessIds = @($process.Id) + @($descendants | ForEach-Object {
    [int]$_.ProcessId
  })
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $auditedProcessIds -contains [int]$_.OwningProcess })
  if ($listeners.Count -gt 0) {
    $summary = $listeners | Format-Table -AutoSize | Out-String
    throw "Native compatibility build opened a TCP listener.`n$summary"
  }
} finally {
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $process.WaitForExit()
  }
  Unregister-Event -SourceIdentifier $processTraceSource -ErrorAction SilentlyContinue
  Get-Event -SourceIdentifier $processTraceSource -ErrorAction SilentlyContinue |
    Remove-Event -ErrorAction SilentlyContinue
}

$registryAfter = Get-LeafMarkRegistrySnapshot
if ($registryAfter -cne $registryBefore) {
  throw "Startup changed LeafMark-related registry state.`nBefore: $registryBefore`nAfter: $registryAfter"
}

$stage = Join-Path $env:RUNNER_TEMP "LeafMark-$Version-Windows-x64-Native-Compat"
if (Test-Path $stage) {
  Remove-Item $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item $resolvedExecutable (Join-Path $stage 'LeafMark.exe')
Copy-Item 'native-compat/README.md' (Join-Path $stage 'README.md')
Copy-Item 'native-compat/THIRD_PARTY_NOTICES.md' (Join-Path $stage 'THIRD_PARTY_NOTICES.md')

$archiveName = "LeafMark_${Version}_Windows_x64_Native-Compat.zip"
$archivePath = Join-Path $resolvedArchiveDirectory $archiveName
if (Test-Path $archivePath) {
  Remove-Item $archivePath -Force
}
Compress-Archive `
  -Path (Join-Path $stage '*') `
  -DestinationPath $archivePath `
  -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $entries = @($zip.Entries | ForEach-Object FullName | Sort-Object)
} finally {
  $zip.Dispose()
}
$expectedEntries = @(
  'LeafMark.exe',
  'README.md',
  'THIRD_PARTY_NOTICES.md'
) | Sort-Object
$unexpected = @(Compare-Object $entries $expectedEntries)
if ($unexpected.Count -ne 0) {
  throw "Archive entries are not exact: $($entries -join ', ')"
}

$archiveInfo = Get-Item $archivePath
if ($archiveInfo.Length -gt 35MB) {
  throw "Native compatibility archive exceeds the 35 MiB limit: $($archiveInfo.Length) bytes"
}
$hash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
Write-Host "Verified native compatibility archive: $archivePath"
Write-Host "Size: $($archiveInfo.Length) bytes"
Write-Host "SHA-256: $hash"

if (-not [string]::IsNullOrWhiteSpace($GithubOutputPath)) {
  "archive_path=$archivePath" | Out-File $GithubOutputPath -Append -Encoding utf8
  "archive_name=$archiveName" | Out-File $GithubOutputPath -Append -Encoding utf8
  "archive_size=$($archiveInfo.Length)" | Out-File $GithubOutputPath -Append -Encoding utf8
  "archive_sha256=$hash" | Out-File $GithubOutputPath -Append -Encoding utf8
}
