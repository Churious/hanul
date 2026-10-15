param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("DenyCreate", "Restore")]
    [string] $Mode,
    [Parameter(Mandatory = $true)]
    [string] $Directory
)

$ErrorActionPreference = "Stop"
$resolvedDirectory = [System.IO.Path]::GetFullPath($Directory)
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
if (-not (Test-Path -LiteralPath $resolvedDirectory -PathType Container)) {
    throw "The isolated E2E ACL target directory does not exist."
}
if (-not $resolvedDirectory.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
    [System.IO.Path]::GetFileName([System.IO.Directory]::GetParent($resolvedDirectory).FullName) -notmatch '^hanul-v102c-e2e-') {
    throw "Refusing to change ACL outside the current user's temp directory."
}

$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($Mode -eq "DenyCreate") {
    & icacls.exe $resolvedDirectory /deny "*$($sid):(WD,AD)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls could not add an isolated create-file denial (exit $LASTEXITCODE)." }
    Write-Output "Denied file and subdirectory creation for the current user in the isolated E2E folder."
    exit 0
}

& icacls.exe $resolvedDirectory /remove:d "*$sid" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls could not remove the isolated denial (exit $LASTEXITCODE)." }
Write-Output "Removed the explicit E2E denial; inherited and allow rules remain unchanged."
