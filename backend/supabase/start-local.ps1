param(
  [Parameter(Mandatory = $false)]
  [ValidateSet('Prepare', 'Recover', 'Start', 'Stop')]
  [string]$Action = 'Start',

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 999)]
  [int]$ConfirmedPostgresMajorVersion,

  [Parameter(Mandatory = $false)]
  [string]$ConfirmIncompleteStageRecovery
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectId = 'beauty-pluz-win2-local'
$ApprovedPostgresMajorVersion = 17
$CredentialTarget = 'BeautyPluz.LocalSupabase.JWTSigningSecret'
$CliVersion = '2.121.0'
$MarkerName = '.beauty-pluz-local-stage'
$ReadyMarkerName = '.beauty-pluz-local-stage-ready'

function Stop-Safely([string]$Message) {
  if ($Action -eq 'Start') {
    throw $Message
  }
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

function Assert-NoSecretInStage([string]$Directory, [string]$Secret) {
  if ([string]::IsNullOrEmpty($Secret)) { return }
  foreach ($file in Get-ChildItem -LiteralPath $Directory -File -Force -Recurse) {
    $contents = [System.IO.File]::ReadAllText($file.FullName)
    if ($contents.Contains($Secret)) {
      throw 'The JWT credential was found in a staging file; refusing to continue.'
    }
  }
}

function Assert-NoReparsePointsInStage([string]$Directory) {
  $pendingDirectories = [System.Collections.Generic.Stack[string]]::new()
  $pendingDirectories.Push($Directory)
  while ($pendingDirectories.Count -gt 0) {
    $currentDirectory = $pendingDirectories.Pop()
    $currentItem = Get-Item -LiteralPath $currentDirectory -Force -ErrorAction Stop
    if (($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'The staging directory contains a nested reparse point; refusing to use or delete it.'
    }
    foreach ($item in Get-ChildItem -LiteralPath $currentDirectory -Force -ErrorAction Stop) {
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The staging directory contains a nested reparse point; refusing to use or delete it.'
      }
      if ($item.PSIsContainer) {
        $pendingDirectories.Push($item.FullName)
      }
    }
  }
}

function Get-FunctionVerifyJwtSettings([string]$ConfigText) {
  $settings = @{}
  $assignmentCounts = @{}
  $currentFunction = $null
  foreach ($line in ($ConfigText -split '\r?\n')) {
    if ($line -match '^[ \t]*\[functions\.([A-Za-z0-9_-]+)\][ \t]*(?:#.*)?$') {
      $currentFunction = $Matches[1]
      if ($settings.ContainsKey($currentFunction)) {
        throw 'A function section is duplicated in a local Supabase config.'
      }
      $settings[$currentFunction] = $true
      $assignmentCounts[$currentFunction] = 0
      continue
    }
    if ($line -match '^[ \t]*\[') {
      $currentFunction = $null
      continue
    }
    if ($null -ne $currentFunction -and $line -match '^[ \t]*verify_jwt[ \t]*=[ \t]*(.*?)[ \t]*$') {
      $assignmentCounts[$currentFunction]++
      if ($assignmentCounts[$currentFunction] -gt 1) {
        throw 'A function has duplicate verify_jwt settings in a local Supabase config.'
      }
      $setting = [regex]::Replace($Matches[1], '[ \t]+#.*$', '').Trim()
      if ($setting -cnotmatch '^(true|false)$') {
        throw 'A function has an invalid verify_jwt setting in a local Supabase config.'
      }
      $settings[$currentFunction] = ($setting -ceq 'true')
    }
  }
  if ($settings.Count -eq 0) {
    throw 'The local Supabase config has no Edge Function sections.'
  }
  return $settings
}

function Assert-JwtSecretEnvironmentReference([string]$ConfigText, [string]$Context) {
  $settings = [regex]::Matches($ConfigText, '(?m)^[ \t]*jwt_secret[ \t]*=[ \t]*([^\r\n]*)$')
  if ($settings.Count -ne 1 -or
    [regex]::Replace($settings[0].Groups[1].Value, '[ \t]+#.*$', '').Trim() -cne '"env(BEAUTY_PLUZ_LOCAL_JWT_SECRET)"') {
    throw "$Context must contain exactly one JWT secret environment reference."
  }
}

function Assert-NoUnexpectedCredentialOverrides([string]$ConfigText, [string]$Context) {
  $credentialKeyPattern = '(?:jwtsecret|anonkey|servicerolekey|publishablekey|secret|password|passwd|pass|pwd|token|credential|apikey|accesskey|privatekey|signingkey|clientsecret|clientkey|webhooksecret|refreshtoken|bearertoken|key$)'
  foreach ($line in ($ConfigText -split '\r?\n')) {
    if ($line -match '^[ \t]*([A-Za-z0-9_-]+)[ \t]*=') {
      $key = $Matches[1]
      $normalizedKey = ($key -replace '[-_]', '').ToLowerInvariant()
      if ($key -ceq 'jwt_secret') {
        continue
      }
      if ($normalizedKey -match $credentialKeyPattern) {
        throw "$Context contains an unexpected credential override."
      }
    }
  }
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

function Assert-StagedConfig([string]$ConfigPath, [int]$MajorVersion, [string]$ExpectedConfigPath) {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw 'The persistent staging directory has no config.toml; refusing to reuse or delete it.'
  }
  $config = [System.IO.File]::ReadAllText($ConfigPath)
  Assert-NoUnexpectedCredentialOverrides $config 'The staged config'
  Assert-JwtSecretEnvironmentReference $config 'The staged config'
  if ($config -notmatch ('(?m)^project_id\s*=\s*"' + [regex]::Escape($ProjectId) + '"\s*$') -or
    $config -notmatch ('(?m)^major_version\s*=\s*' + [string]$MajorVersion + '\s*$')) {
    throw 'The staged config project ID, PostgreSQL version, or JWT environment reference does not match.'
  }
  if (-not (Test-Path -LiteralPath $ExpectedConfigPath -PathType Leaf)) {
    throw 'The intended local Supabase config is missing; refusing to validate staged function auth settings.'
  }
  $expectedSettings = Get-FunctionVerifyJwtSettings ([System.IO.File]::ReadAllText($ExpectedConfigPath))
  $stagedSettings = Get-FunctionVerifyJwtSettings $config
  foreach ($name in @($expectedSettings.Keys) + @($stagedSettings.Keys) | Sort-Object -Unique) {
    $expectedValue = $true
    $stagedValue = $true
    if ($expectedSettings.ContainsKey($name)) { $expectedValue = $expectedSettings[$name] }
    if ($stagedSettings.ContainsKey($name)) { $stagedValue = $stagedSettings[$name] }
    if ($expectedValue -ne $stagedValue) {
      throw 'A staged Edge Function verify_jwt setting differs from the intended local config.'
    }
  }
  foreach ($name in @('create-checkout-order', 'verify-sumup-payment', 'reconcile-sumup-checkouts')) {
    $section = '[functions.' + $name + ']'
    $match = [regex]::Match($config, '(?ms)^' + [regex]::Escape($section) + '\s*\n.*?(?=^\[|\z)')
    if (-not $match.Success -or $match.Value -notmatch '(?m)^enabled\s*=\s*false\s*$') {
      throw 'A checkout function is not explicitly disabled in the staged config.'
    }
  }
  if ($config -match '(?ms)^\[edge_runtime\]\s*\nenabled\s*=\s*true') {
    throw 'Edge Runtime must remain disabled in the staged local config.'
  }
}

function Assert-StageReady([string]$Directory, [bool]$AllowCompleteLegacyStage = $false) {
  $readyPath = Join-Path $Directory $ReadyMarkerName
  if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
    $legacyConfig = Join-Path $Directory 'supabase\config.toml'
    $legacyMigrations = Join-Path $Directory 'supabase\migrations'
    $legacyFunctions = Join-Path $Directory 'supabase\functions'
    if ($AllowCompleteLegacyStage -and
      (Test-Path -LiteralPath $legacyConfig -PathType Leaf) -and
      (Test-Path -LiteralPath $legacyMigrations -PathType Container) -and
      (Test-Path -LiteralPath $legacyFunctions -PathType Container)) {
      return
    }
    throw 'The persistent staging directory is incomplete; it has been preserved for recovery.'
  }
  $readyMarker = [System.IO.File]::ReadAllText($readyPath)
  if ($readyMarker -cne "beauty-pluz-local-stage-ready-v1`nproject_id=$ProjectId`n") {
    throw 'The staging readiness marker does not match this project; refusing to reuse or delete it.'
  }
}

function Set-StagedConfig([string]$SourceConfig, [string]$DestinationConfig) {
  $text = [System.IO.File]::ReadAllText($SourceConfig) -replace "`r`n?", "`n"
  if ($text -notmatch ('(?m)^project_id\s*=\s*"' + [regex]::Escape($ProjectId) + '"\s*$')) {
    throw 'Repository config does not have the approved isolated project ID.'
  }
  Assert-NoUnexpectedCredentialOverrides $text 'Repository config'
  Assert-JwtSecretEnvironmentReference $text 'Repository config'

  if ($text -match '(?m)^\s*major_version\s*=') {
    $configuredVersion = [regex]::Match($text, '(?m)^\s*major_version\s*=\s*(\d+)\s*$').Groups[1].Value
    if ($configuredVersion -ne [string]$ApprovedPostgresMajorVersion) {
      throw 'Repository PostgreSQL major version differs from the approved local version.'
    }
  } else {
    $dbSection = [regex]::new('(?m)^\[db\]\s*$')
    if (-not $dbSection.IsMatch($text)) {
      throw 'Repository config is missing the database section required for the approved PostgreSQL version.'
    }
    $text = $dbSection.Replace($text, "[db]`nmajor_version = $ApprovedPostgresMajorVersion", 1)
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
  Assert-NoUnexpectedCredentialOverrides $text 'Staged config'
  Assert-JwtSecretEnvironmentReference $text 'Staged config'
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
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if (-not $acl.AreAccessRulesProtected -or $ownerSid.Value -ne $sid.Value) {
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
    if ([string]::IsNullOrWhiteSpace($inspect.Stdout)) {
      throw 'Docker returned empty mount details; the staging directory will be preserved.'
    }
    try {
      $mounts = $inspect.Stdout | ConvertFrom-Json
    } catch {
      throw 'Docker mount details could not be parsed; the staging directory will be preserved.'
    }
    if ($null -eq $mounts) {
      throw 'Docker returned empty mount details; the staging directory will be preserved.'
    }
    foreach ($mount in $mounts) {
      if ($null -eq $mount -or $null -eq $mount.PSObject.Properties['Source']) {
        throw 'Docker returned incomplete mount details; the staging directory will be preserved.'
      }
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

function Recover-IncompleteStage([string]$Directory, [string]$RepositoryRoot, [string]$ConfirmedProjectId) {
  if ($ConfirmedProjectId -cne $ProjectId) {
    throw 'Incomplete-stage recovery requires explicit confirmation using the exact project ID.'
  }
  $expectedDirectory = [System.IO.Path]::GetFullPath((Get-StageRoot)).TrimEnd('\', '/')
  $providedDirectory = [System.IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
  if (-not $providedDirectory.Equals($expectedDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Incomplete-stage recovery is restricted to this project staging directory.'
  }
  Assert-OutsideRepository $providedDirectory $RepositoryRoot
  if (-not (Test-Path -LiteralPath $providedDirectory -PathType Container)) {
    throw 'Incomplete-stage recovery requires the existing staging directory.'
  }
  Assert-NoReparsePointsInStage $providedDirectory
  $children = @(Get-ChildItem -LiteralPath $providedDirectory -Force -ErrorAction Stop)
  if ($children.Count -ne 0) {
    throw 'Incomplete-stage recovery requires an empty directory; existing contents are preserved.'
  }
  Assert-ProtectedStageAcl $providedDirectory
  if (Test-RunningContainerMountsStage $providedDirectory) {
    throw 'Incomplete-stage recovery is blocked because a running container mounts the staging directory.'
  }
  $markerPath = Join-Path $providedDirectory $MarkerName
  [System.IO.File]::WriteAllText(
    $markerPath,
    "beauty-pluz-local-stage-v1`nproject_id=$ProjectId`n",
    [System.Text.UTF8Encoding]::new($false)
  )
}

$secret = $null
$cliResult = $null
$failureStage = 'launcher validation'
$safeFailureDetail = $null

try {
  if (-not $PSBoundParameters.ContainsKey('ConfirmedPostgresMajorVersion')) {
    Stop-Safely 'Operation blocked: confirm the intended PostgreSQL major version and pass -ConfirmedPostgresMajorVersion.'
  }
  if ($ConfirmedPostgresMajorVersion -ne $ApprovedPostgresMajorVersion) {
    Stop-Safely "Operation blocked: this isolated local environment is approved for PostgreSQL major version $ApprovedPostgresMajorVersion only."
  }

  $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  $sourceConfig = Join-Path $PSScriptRoot 'config.toml'
  $stageRoot = Get-StageRoot
  Assert-OutsideRepository $stageRoot $repoRoot
  $stageRootExisted = Test-Path -LiteralPath $stageRoot -PathType Container
  $stageSupabase = Join-Path $stageRoot 'supabase'
  $stageConfig = Join-Path $stageSupabase 'config.toml'
  $stageFunctions = Join-Path $stageSupabase 'functions'

  if ($Action -eq 'Start') {
    $failureStage = 'Credential Manager validation'
    $secret = Get-CredentialSecret $CredentialTarget
    if ([string]::IsNullOrWhiteSpace($secret) -or $secret.Length -lt 32 -or $secret -notmatch '^[A-Za-z0-9_+/=-]{32,}$') {
      Stop-Safely 'Start blocked: the local JWT credential is missing, empty, or invalid in Windows Credential Manager.'
    }
  }

  if ($Action -eq 'Recover') {
    $failureStage = 'incomplete-stage recovery checks'
    Recover-IncompleteStage $stageRoot $repoRoot $ConfirmIncompleteStageRecovery
  } elseif (Test-Path -LiteralPath $stageRoot) {
    $failureStage = 'staging identity and ACL validation'
    $stageItem = Get-Item -LiteralPath $stageRoot -Force
    if (($stageItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Stop-Safely 'Operation blocked: the staging path is a reparse point; refusing to reuse or delete it.'
    }
    Assert-NoReparsePointsInStage $stageRoot
    Assert-StageIdentity $stageRoot $stageConfig
    Assert-ProtectedStageAcl $stageRoot
  } elseif ($Action -eq 'Stop') {
    Stop-Safely 'Stop blocked: the persistent Beauty Pluz staging directory does not exist.'
  } else {
    $failureStage = 'protected staging directory initialization'
    Initialize-ProtectedStage $stageRoot
    $markerPath = Join-Path $stageRoot $MarkerName
    [System.IO.File]::WriteAllText($markerPath, "beauty-pluz-local-stage-v1`nproject_id=$ProjectId`n", [System.Text.UTF8Encoding]::new($false))
  }

  $failureStage = 'staging reparse-point and dotenv validation'
  Assert-NoReparsePointsInStage $stageRoot
  Assert-NoDotenvFiles $stageRoot

  if ($Action -in @('Prepare', 'Start') -and $stageRootExisted) {
    $readyPath = Join-Path $stageRoot $ReadyMarkerName
    if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
      $failureStage = 'staging Docker mount validation'
      if (Test-RunningContainerMountsStage $stageRoot) {
        $safeFailureDetail = 'The incomplete staging directory is mounted by a running container and was preserved.'
        throw 'Staging reuse is blocked.'
      }
    }
    $failureStage = 'existing staging readiness validation'
    $safeFailureDetail = 'The existing staging directory was preserved. Its readiness marker is missing or invalid; use the separately approved Recover action with the exact project ID only after its checks pass.'
    Assert-StageReady $stageRoot
    $safeFailureDetail = $null
  }

  if ($Action -in @('Prepare', 'Recover', 'Start')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stageRoot $ReadyMarkerName) -PathType Leaf)) {
      $failureStage = 'staging Docker mount validation'
      if (Test-RunningContainerMountsStage $stageRoot) {
        Stop-Safely "$Action blocked: an incomplete stage is mounted by a running container; the stage was preserved."
      }
      $failureStage = 'staged config and project-file preparation'
      New-Item -ItemType Directory -Path $stageSupabase -Force | Out-Null
      Set-StagedConfig $sourceConfig $stageConfig
      New-Item -ItemType Directory -Path $stageFunctions -Force | Out-Null
      Copy-ProjectFilesWithoutDotenv (Join-Path $PSScriptRoot 'migrations') (Join-Path $stageSupabase 'migrations')
      Copy-ProjectFilesWithoutDotenv (Join-Path $PSScriptRoot 'functions') $stageFunctions
      Assert-NoReparsePointsInStage $stageRoot
      Assert-NoDotenvFiles $stageRoot
      Assert-NoSecretInStage $stageRoot $secret
      $readyPath = Join-Path $stageRoot $ReadyMarkerName
      [System.IO.File]::WriteAllText($readyPath, "beauty-pluz-local-stage-ready-v1`nproject_id=$ProjectId`n", [System.Text.UTF8Encoding]::new($false))
    }
    $failureStage = 'staged readiness, PostgreSQL, JWT, and function-auth validation'
    Assert-StageReady $stageRoot
    Assert-StagedConfig $stageConfig $ApprovedPostgresMajorVersion $sourceConfig
    Assert-NoReparsePointsInStage $stageRoot
    Assert-NoSecretInStage $stageRoot $secret
  } elseif ($Action -eq 'Stop') {
    Assert-StageReady $stageRoot $true
    Assert-StagedConfig $stageConfig $ApprovedPostgresMajorVersion $sourceConfig
    Assert-NoReparsePointsInStage $stageRoot
    Assert-NoSecretInStage $stageRoot $null
  }

  if ($Action -in @('Prepare', 'Recover')) {
    [Console]::Out.WriteLine("Local Supabase staging prepared successfully at: $stageRoot")
    return
  }

  if ($Action -eq 'Stop') {
    if (-not (Test-Path -LiteralPath $stageConfig -PathType Leaf)) {
      Stop-Safely 'Stop blocked: the staged config.toml is missing; the staging directory was preserved.'
    }
  }

  $failureStage = 'local Supabase CLI validation'
  $command = Find-LocalSupabaseCli $PSScriptRoot
  if (-not $command) {
    Stop-Safely 'Operation blocked: local npm Supabase CLI version 2.121.0 was not found.'
  }
  $clearNames = Get-ClearEnvironmentNames
  if (-not (Test-LocalSupabaseCliVersion $command.Shim $stageRoot $clearNames)) {
    Stop-Safely 'Operation blocked: the selected local Supabase CLI binary did not report version 2.121.0.'
  }

  $failureStage = 'Supabase process invocation'
  $verb = if ($Action -eq 'Start') { 'start' } else { 'stop' }
  $cliResult = Invoke-CapturedProcess `
    (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') `
    ('/d /s /c ""{0}" {1}"' -f $command.Shim, $verb) `
    $stageRoot $clearNames $secret
  if ($Action -eq 'Stop') {
    Write-CliResult $cliResult $secret
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
    $failureStage = 'staging cleanup safety checks'
    Assert-NoReparsePointsInStage $stageRoot
    if (Test-RunningContainerMountsStage $stageRoot) {
      Stop-Safely 'Supabase stop succeeded, but a running container still mounts the staging directory; it has been preserved.'
    }
    try {
      $failureStage = 'staging directory cleanup'
      Assert-NoReparsePointsInStage $stageRoot
      Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction Stop
      [Console]::Out.WriteLine('Supabase stopped and no running container mounts the stage. Persistent staging was removed.')
    } catch {
      Stop-Safely 'Supabase stopped, but staging cleanup failed; inspect the persistent staging directory before retrying.'
    }
  }
} catch {
  $safeFailureMessage = "Operation failed safely during $failureStage; no credential values or exception details are included."
  [Console]::Error.WriteLine($safeFailureMessage)
  if ($safeFailureDetail) {
    [Console]::Error.WriteLine($safeFailureDetail)
  }
  exit 1
} finally {
  if ($cliResult) {
    $cliResult.Stdout = $null
    $cliResult.Stderr = $null
  }
  $cliResult = $null
  if ($secret) { $secret = $null }
}