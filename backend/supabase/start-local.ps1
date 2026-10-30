param(
  [Parameter(Mandatory = $false)]
  [ValidateSet('Start', 'Stop')]
  [string]$Action = 'Start',

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 999)]
  [int]$ConfirmedPostgresMajorVersion
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectId = 'beauty-pluz-win2-local'
$CredentialTarget = 'BeautyPluz.LocalSupabase.JWTSigningSecret'
$CliVersion = '2.121.0'
$MarkerName = '.beauty-pluz-local-stage'

function Stop-Safely([string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}

function Get-CredentialSecret([string]$Target) {
  if (-not ('CredentialManagerReader' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CredentialManagerReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern void CredFree(IntPtr buffer);

  public static string ReadGeneric(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) return null;
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return null;
      byte[] bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      try { return new UTF8Encoding(false, true).GetString(bytes); }
      finally { Array.Clear(bytes, 0, bytes.Length); }
    }
    finally { CredFree(pointer); }
  }
}
'@
  }

  return [CredentialManagerReader]::ReadGeneric($Target)
}

function Copy-ProjectFilesWithoutDotenv([string]$SourceDirectory, [string]$DestinationDirectory) {
  if (-not (Test-Path -LiteralPath $SourceDirectory -PathType Container)) {
    throw 'A required project source directory is missing.'
  }
  $sourcePrefix = (Resolve-Path -LiteralPath $SourceDirectory).Path.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  foreach ($file in Get-ChildItem -LiteralPath $SourceDirectory -File -Force -Recurse) {
    if ($file.Name -match '^\.env(?:\.|$)') { continue }
    $relativePath = $file.FullName.Substring($sourcePrefix.Length)
    $destination = Join-Path $DestinationDirectory $relativePath
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
  }
}

function Assert-NoDotenvFiles([string]$Directory) {
  $dotenv = Get-ChildItem -LiteralPath $Directory -Force -Recurse -ErrorAction Stop |
    Where-Object { $_.Name -match '^\.env(?:\.|$)' } |
    Select-Object -First 1
  if ($dotenv) {
    throw 'The protected staging directory contains a dotenv-named file; refusing to use it.'
  }
}

function Set-ProtectedDirectoryAcl([string]$Directory) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Directory -AclObject $acl
}

function Assert-ProtectedStageAcl([string]$Directory) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl -LiteralPath $Directory
  if (-not $acl.AreAccessRulesProtected -or $acl.Owner -ne $sid.Value) {
    throw 'The staging directory ACL or owner is not restricted to the current user.'
  }
  $rules = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or
    $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
    throw 'The staging directory ACL is not the expected current-user-only FullControl ACL.'
  }
}

function Initialize-ProtectedStage([string]$Directory) {
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  Set-ProtectedDirectoryAcl $Directory
  Assert-ProtectedStageAcl $Directory
}

function Assert-StageIdentity([string]$Directory, [string]$ConfigPath) {
  $markerPath = Join-Path $Directory $MarkerName
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw 'The persistent staging directory exists without this project marker; refusing to reuse or delete it.'
  }
  $marker = [System.IO.File]::ReadAllText($markerPath)
  if ($marker -cne "beauty-pluz-local-stage-v1`nproject_id=$ProjectId`n") {
    throw 'The persistent staging directory marker does not match this project; refusing to reuse or delete it.'
  }
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw 'The marked staging directory has no config.toml; refusing to recreate or delete it.'
  }
  $config = [System.IO.File]::ReadAllText($ConfigPath)
  if ($config -notmatch ('(?m)^project_id\s*=\s*"' + [regex]::Escape($ProjectId) + '"\s*$')) {
    throw 'The staged config project ID does not match the project marker.'
  }
}

function Set-StagedConfig([string]$SourceConfig, [string]$DestinationConfig) {
  $text = [System.IO.File]::ReadAllText($SourceConfig) -replace "`r`n?", "`n"
  if ($text -notmatch ('(?m)^project_id\s*=\s*"' + [regex]::Escape($ProjectId) + '"\s*$')) {
    throw 'Repository config does not have the approved isolated project ID.'
  }
  if ([regex]::Matches($text, '(?m)^jwt_secret\s*=\s*"env\(BEAUTY_PLUZ_LOCAL_JWT_SECRET\)"\s*$').Count -ne 1) {
    throw 'Repository config must contain exactly one approved JWT secret env reference.'
  }
  if ($text -match '(?im)^\s*(?:anon_key|service_role_key|publishable_key|secret_key|signing_keys_path)\s*=') {
    throw 'API-key and signing-key overrides must remain unset.'
  }

  if ($text -match '(?m)^\s*major_version\s*=') {
    $configuredVersion = [regex]::Match($text, '(?m)^\s*major_version\s*=\s*(\d+)\s*$').Groups[1].Value
    if ($configuredVersion -ne [string]$ConfirmedPostgresMajorVersion) {
      throw 'Configured PostgreSQL major version differs from the explicit confirmation.'
    }
  } else {
    $text = [regex]::new('(?m)^\[db\]\s*$').Replace($text, "[db]`nmajor_version = $ConfirmedPostgresMajorVersion", 1)
  }

  foreach ($name in @('create-checkout-order', 'verify-sumup-payment', 'reconcile-sumup-checkouts')) {
    $table = '[functions.' + $name + ']'
    $pattern = '(?ms)^' + [regex]::Escape($table) + '\s*\n.*?(?=^\[|\z)'
    $match = [regex]::Match($text, $pattern)
    if (-not $match.Success) {
      throw "Repository config is missing $table."
    }
    $replacement = [regex]::Replace($match.Value, '(?m)^enabled\s*=\s*.*$', 'enabled = false')
    if ($replacement -eq $match.Value) {
      $replacement = $match.Value.TrimEnd() + "`nenabled = false`n"
    }
    $text = $text.Substring(0, $match.Index) + $replacement + $text.Substring($match.Index + $match.Length)
  }

  if ($text -match '(?ms)^\[edge_runtime\]\s*\nenabled\s*=\s*true') {
    throw 'Edge Runtime must remain disabled in the staged local config.'
  }
  if ([regex]::Matches($text, '(?m)^jwt_secret\s*=\s*"env\(BEAUTY_PLUZ_LOCAL_JWT_SECRET\)"\s*$').Count -ne 1) {
    throw 'Staged config must retain exactly one JWT secret env reference.'
  }
  [System.IO.File]::WriteAllText($DestinationConfig, $text, [System.Text.UTF8Encoding]::new($false))
}

function Find-LocalSupabaseCli([string]$StartingDirectory) {
  $directory = [System.IO.DirectoryInfo]::new($StartingDirectory)
  while ($null -ne $directory) {
    $moduleDirectory = Join-Path $directory.FullName 'node_modules'
    $packageManifest = Join-Path $moduleDirectory 'supabase\package.json'
    $shim = Join-Path $moduleDirectory '.bin\supabase.cmd'
    if ((Test-Path -LiteralPath $packageManifest -PathType Leaf) -and (Test-Path -LiteralPath $shim -PathType Leaf)) {
      $package = Get-Content -LiteralPath $packageManifest -Raw | ConvertFrom-Json
      if ($package.version -ne '2.121.0') {
        throw 'The nearest local npm Supabase CLI package is not version 2.121.0.'
      }
      return [pscustomobject]@{ Shim = $shim; Version = $package.version }
    }
    $directory = $directory.Parent
  }
  return $null
}

function Invoke-CapturedProcess([string]$FileName, [string]$Arguments, [string]$WorkingDirectory, [string[]]$VariablesToClear, [string]$Secret) {
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $FileName
  $info.Arguments = $Arguments
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  foreach ($name in $VariablesToClear) {
    $info.EnvironmentVariables.Remove($name) | Out-Null
  }
  if ($null -ne $Secret) {
    $info.EnvironmentVariables['BEAUTY_PLUZ_LOCAL_JWT_SECRET'] = $Secret
    if ($info.EnvironmentVariables['BEAUTY_PLUZ_LOCAL_JWT_SECRET'] -cne $Secret) {
      throw 'The child process environment could not be bound to the Credential Manager secret.'
    }
  }

  $child = [System.Diagnostics.Process]::new()
  $child.StartInfo = $info
  try {
    $null = $child.Start()
    $stdoutTask = $child.StandardOutput.ReadToEndAsync()
    $stderrTask = $child.StandardError.ReadToEndAsync()
    $child.WaitForExit()
    return [pscustomobject]@{
      ExitCode = $child.ExitCode
      Stdout = $stdoutTask.GetAwaiter().GetResult()
      Stderr = $stderrTask.GetAwaiter().GetResult()
    }
  } finally {
    $info.EnvironmentVariables.Remove('BEAUTY_PLUZ_LOCAL_JWT_SECRET') | Out-Null
    $child.Dispose()
  }
}

function Test-LocalSupabaseCliVersion([string]$Shim, [string]$WorkingDirectory, [string[]]$VariablesToClear) {
  $result = Invoke-CapturedProcess `
    (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') `
    ('/d /s /c ""{0}" --version"' -f $Shim) `
    $WorkingDirectory $VariablesToClear $null
  return ($result.ExitCode -eq 0) -and (($result.Stdout + "`n" + $result.Stderr) -match '(?mi)^\s*(?:supabase(?:\s+cli)?\s+)?v?2\.121\.0\s*$')
}

function Write-RedactedLine([string]$Line, [string]$Secret) {
  $redacted = $Line
  if ($Secret) { $redacted = $redacted.Replace($Secret, '[REDACTED]') }
  $redacted = [regex]::Replace($redacted, '(?i)("?(?:anon[\s_-]*key|service[\s_-]*role[\s_-]*key|publishable[\s_-]*key|secret[\s_-]*key|jwt[\s_-]*secret|authorization|api[\s_-]*key)"?\s*[:=]\s*)("[^"]*"|\S+)', '$1[REDACTED]')
  $redacted = [regex]::Replace($redacted, '(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])', '[REDACTED-JWT]')
  $redacted = [regex]::Replace($redacted, '(?i)\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+', '[REDACTED-API-KEY]')
  $redacted = [regex]::Replace($redacted, '(?i)(\b(?:postgres(?:ql)?|https?)://[^:/\s]+:)[^@/\s]+(@)', '$1[REDACTED]$2')
  return $redacted
}

function Write-CliResult($Result, [string]$Secret) {
  foreach ($line in ($Result.Stdout -split '\r?\n')) {
    if ($line) { [Console]::Out.WriteLine((Write-RedactedLine $line $Secret)) }
  }
  foreach ($line in ($Result.Stderr -split '\r?\n')) {
    if ($line) { [Console]::Error.WriteLine((Write-RedactedLine $line $Secret)) }
  }
}

function Get-StageRoot {
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'The current user Local AppData directory could not be resolved.'
  }
  return Join-Path $localAppData 'BeautyPluz\Supabase\beauty-pluz-win2-local'
}

function Assert-OutsideRepository([string]$Directory, [string]$RepositoryRoot) {
  $stageFull = [System.IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
  $repoFull = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\', '/')
  if ($stageFull.Equals($repoFull, [System.StringComparison]::OrdinalIgnoreCase) -or
    $stageFull.StartsWith($repoFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The protected staging directory must be outside the repository.'
  }
}

function Assert-ProtectedStageAcl([string]$Directory) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl -LiteralPath $Directory
  if (-not $acl.AreAccessRulesProtected -or $acl.Owner -ne $sid.Value) {
    throw 'The staging directory ACL or owner is not restricted to the current user.'
  }
  $rules = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or
    $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
    throw 'The staging directory ACL is not the expected current-user-only FullControl ACL.'
  }
}

function Set-ProtectedDirectoryAcl([string]$Directory) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Directory -AclObject $acl
}

function Initialize-ProtectedStage([string]$Directory) {
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  Set-ProtectedDirectoryAcl $Directory
  Assert-ProtectedStageAcl $Directory
}

function Assert-StageIdentity([string]$Directory, [string]$ConfigPath) {
  $markerPath = Join-Path $Directory $MarkerName
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw 'The persistent staging directory exists without this project marker; refusing to reuse or delete it.'
  }
  $marker = [System.IO.File]::ReadAllText($markerPath)
  if ($marker -cne "beauty-pluz-local-stage-v1`nproject_id=$ProjectId`n") {
    throw 'The persistent staging directory marker does not match this project; refusing to reuse or delete it.'
  }
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw 'The marked staging directory has no config.toml; refusing to recreate or delete it.'
  }
  $config = [System.IO.File]::ReadAllText($ConfigPath)
  if ($config -notmatch ('(?m)^project_id\s*=\s*"' + [regex]::Escape($ProjectId) + '"\s*$')) {
    throw 'The staged config project ID does not match the project marker.'
  }
}

function Get-ClearEnvironmentNames {
  return @(
    'SUPABASE_PROJECT_ID', 'SUPABASE_API_PORT', 'SUPABASE_DB_PORT', 'SUPABASE_DB_MAJOR_VERSION',
    'SUPABASE_STUDIO_ENABLED', 'SUPABASE_STUDIO_PORT', 'SUPABASE_LOCAL_SMTP_ENABLED',
    'SUPABASE_LOCAL_SMTP_PORT', 'SUPABASE_STORAGE_ENABLED', 'SUPABASE_ANALYTICS_ENABLED',
    'SUPABASE_EDGE_RUNTIME_ENABLED', 'SUPABASE_DB_POOLER_ENABLED', 'SUPABASE_EXPERIMENTAL_STACK',
    'SUPABASE_AUTH_JWT_SECRET', 'SUPABASE_AUTH_ANON_KEY', 'SUPABASE_AUTH_SERVICE_ROLE_KEY',
    'SUPABASE_AUTH_PUBLISHABLE_KEY', 'SUPABASE_AUTH_SECRET_KEY', 'SUPABASE_AUTH_SIGNING_KEYS_PATH',
    'BEAUTY_PLUZ_LOCAL_JWT_SECRET', 'CHECKOUT_TRUSTED_INGRESS_CONFIRMED',
    'CHECKOUT_TRUSTED_IP_HEADER', 'SUPABASE_ENV', 'SUPABASE_WORKDIR'
  )
}

function Test-RunningContainerMountsStage([string]$StageDirectory) {
  $docker = Get-Command docker.exe -ErrorAction SilentlyContinue
  if (-not $docker) {
    throw 'Docker CLI is unavailable; cannot verify whether running containers depend on the staging directory.'
  }
  $list = Invoke-CapturedProcess $docker.Source 'ps --quiet' $StageDirectory @() $null
  if ($list.ExitCode -ne 0) {
    throw 'Docker could not list running containers; the staging directory will be preserved.'
  }

  $stageNormalized = [System.IO.Path]::GetFullPath($StageDirectory).TrimEnd('\', '/').Replace('/', '\').ToLowerInvariant()
  $stagePosix = $stageNormalized -replace '^([a-z]):', '/run/desktop/mnt/host/$1' -replace '\\', '/'
  foreach ($containerId in ($list.Stdout -split '\r?\n')) {
    $id = $containerId.Trim()
    if (-not $id) { continue }
    if ($id -notmatch '^[A-Fa-f0-9]+$') {
      throw 'Docker returned an unexpected container identifier; the staging directory will be preserved.'
    }
    $inspect = Invoke-CapturedProcess $docker.Source ('inspect --format "{{json .Mounts}}" ' + $id) $StageDirectory @() $null
    if ($inspect.ExitCode -ne 0) {
      throw 'Docker could not inspect a running container; the staging directory will be preserved.'
    }
    try {
      $mounts = $inspect.Stdout | ConvertFrom-Json
    } catch {
      throw 'Docker mount details could not be parsed; the staging directory will be preserved.'
    }
    foreach ($mount in $mounts) {
      if (-not $mount.Source) { continue }
      $source = ([string]$mount.Source).TrimEnd('\', '/').Replace('/', '\').ToLowerInvariant()
      $sourcePosix = $source -replace '^([a-z]):', '/run/desktop/mnt/host/$1' -replace '\\', '/'
      if ($source -eq $stageNormalized -or $source.StartsWith($stageNormalized + '\') -or
        $sourcePosix -eq $stagePosix -or $sourcePosix.StartsWith($stagePosix + '/')) {
        return $true
      }
    }
  }
  return $false
}

if (-not $PSBoundParameters.ContainsKey('ConfirmedPostgresMajorVersion')) {
  Stop-Safely 'Operation blocked: confirm the intended PostgreSQL major version and pass -ConfirmedPostgresMajorVersion.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sourceConfig = Join-Path $PSScriptRoot 'config.toml'
$stageRoot = Get-StageRoot
Assert-OutsideRepository $stageRoot $repoRoot
$stageSupabase = Join-Path $stageRoot 'supabase'
$stageConfig = Join-Path $stageSupabase 'config.toml'
$stageFunctions = Join-Path $stageSupabase 'functions'
$secret = $null
$cliResult = $null
$removeStageAfterStop = $false

try {
  $secret = Get-CredentialSecret $CredentialTarget
  if ([string]::IsNullOrWhiteSpace($secret) -or $secret.Length -lt 32 -or $secret -notmatch '^[A-Za-z0-9_+/=-]{32,}$') {
    Stop-Safely 'Operation blocked: the local JWT credential is missing, empty, or invalid in Windows Credential Manager.'
  }

  if (Test-Path -LiteralPath $stageRoot) {
    Assert-StageIdentity $stageRoot $stageConfig
    Assert-ProtectedStageAcl $stageRoot
  } elseif ($Action -eq 'Stop') {
    Stop-Safely 'Stop blocked: the persistent Beauty Pluz staging directory does not exist.'
  } else {
    Initialize-ProtectedStage $stageRoot
  }

  New-Item -ItemType Directory -Path $stageSupabase -Force | Out-Null
  Assert-NoDotenvFiles $stageRoot
  $markerPath = Join-Path $stageRoot $MarkerName
  if (-not (Test-Path -LiteralPath $markerPath)) {
    [System.IO.File]::WriteAllText($markerPath, "beauty-pluz-local-stage-v1`nproject_id=$ProjectId`n", [System.Text.UTF8Encoding]::new($false))
  }

  if ($Action -eq 'Start') {
    Set-StagedConfig $sourceConfig $stageConfig
    New-Item -ItemType Directory -Path $stageFunctions -Force | Out-Null
    Copy-ProjectFilesWithoutDotenv (Join-Path $PSScriptRoot 'migrations') (Join-Path $stageSupabase 'migrations')
    Copy-ProjectFilesWithoutDotenv (Join-Path $PSScriptRoot 'functions') $stageFunctions
    Assert-NoDotenvFiles $stageRoot
  } else {
    $stagedText = [System.IO.File]::ReadAllText($stageConfig)
    if ($stagedText -notmatch ('(?m)^project_id\s*=\s*"' + [regex]::Escape($ProjectId) + '"\s*$') -or
      $stagedText -notmatch ('(?m)^major_version\s*=\s*' + [string]$ConfirmedPostgresMajorVersion + '\s*$') -or
      $stagedText -notmatch '(?m)^jwt_secret\s*=\s*"env\(BEAUTY_PLUZ_LOCAL_JWT_SECRET\)"\s*$') {
      Stop-Safely 'Stop blocked: staged project ID, confirmed PostgreSQL version, or JWT reference does not match.'
    }
  }

  $command = Find-LocalSupabaseCli $PSScriptRoot
  if (-not $command) {
    Stop-Safely 'Operation blocked: local npm Supabase CLI version 2.121.0 was not found.'
  }
  $clearNames = Get-ClearEnvironmentNames
  if (-not (Test-LocalSupabaseCliVersion $command.Shim $stageRoot $clearNames)) {
    Stop-Safely 'Operation blocked: the selected local Supabase CLI binary did not report version 2.121.0.'
  }

  $verb = if ($Action -eq 'Start') { 'start' } else { 'stop' }
  $cliResult = Invoke-CapturedProcess `
    (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') `
    ('/d /s /c ""{0}" {1}"' -f $command.Shim, $verb) `
    $stageRoot $clearNames $secret
  Write-RedactedOutput $cliResult.Stdout $secret
  foreach ($line in ($cliResult.Stderr -split '\r?\n')) {
    if ($line) { [Console]::Error.WriteLine((Write-RedactedLine $line $secret)) }
  }
  if ($cliResult.ExitCode -ne 0) {
    if ($Action -eq 'Start') {
      Stop-Safely 'Supabase start failed; the persistent staging directory was preserved for recovery.'
    }
    Stop-Safely 'Supabase stop failed; the persistent staging directory was preserved.'
  }

  if ($Action -eq 'Start') {
    [Console]::Out.WriteLine("Supabase start succeeded. Persistent staging remains at: $stageRoot")
  } else {
    if (Test-RunningContainerMountsStage $stageRoot) {
      Stop-Safely 'Supabase stop succeeded, but a running container still mounts the staging directory; it has been preserved.'
    }
    $removeStageAfterStop = $true
  }
} catch {
  Stop-Safely "Operation failed safely: $($_.Exception.Message)"
} finally {
  if ($cliResult) {
    $cliResult.Stdout = $null
    $cliResult.Stderr = $null
  }
  $cliResult = $null
  if ($secret) { $secret = $null }
  if ($removeStageAfterStop -and (Test-Path -LiteralPath $stageRoot)) {
    try {
      Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction Stop
      [Console]::Out.WriteLine('Supabase stopped; no running container mounts the stage. Persistent staging was removed.')
    } catch {
      [Console]::Error.WriteLine('Supabase stopped, but staging cleanup failed. The directory was preserved for manual recovery.')
    }
  }
}