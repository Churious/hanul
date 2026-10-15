param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Open", "Save", "Cancel", "Close", "WaitClosed", "GetPid")]
    [string] $Mode,
    [string] $OwnerTitle = "Hanul V1-02c E2E",
    [string] $Path,
    [int] $ExpectedPid,
    [switch] $CloseAppBeforeSelection,
    [int] $TimeoutSeconds = 35
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace HanulE2E {
    public static class NativeWindows {
        public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")]
        private static extern bool EnumChildWindows(IntPtr hWnd, EnumChildProc callback, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern int GetDlgCtrlID(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
        private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxCount);
        public static IntPtr FindChild(IntPtr parent, int controlId, string className) {
            IntPtr found = IntPtr.Zero;
            EnumChildProc callback = (hWnd, lParam) => {
                var name = new System.Text.StringBuilder(256);
                GetClassName(hWnd, name, name.Capacity);
                if (GetDlgCtrlID(hWnd) == controlId && name.ToString() == className) {
                    found = hWnd;
                    return false;
                }
                return true;
            };
            EnumChildWindows(parent, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return found;
        }
        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
        public static extern IntPtr SendMessageText(IntPtr hWnd, uint message, IntPtr wParam, string text);
        [DllImport("user32.dll", EntryPoint = "SendMessageW")]
        public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
    }
}
"@

$root = [System.Windows.Automation.AutomationElement]::RootElement
$ownerCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $OwnerTitle
)
$ownerWindow = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $ownerCondition)

if ($Mode -eq "WaitClosed") {
    $untilClosed = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $appWindow = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $ownerCondition)
        if (-not $appWindow) {
            if ($ExpectedPid -gt 0) {
                $process = Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue
                if ($process) {
                    Start-Sleep -Milliseconds 150
                    continue
                }
                Write-Output "Hanul window and process $ExpectedPid are closed"
                exit 0
            }
            Write-Output "Hanul window is closed"
            exit 0
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $untilClosed)
    throw "Hanul 창이 $TimeoutSeconds 초 뒤에도 닫히지 않았습니다."
}

if ($Mode -ne "WaitClosed" -and -not $ownerWindow) {
    throw "대상 Hanul 창 '$OwnerTitle'을 찾지 못했습니다. 다른 응용 프로그램은 탐색하지 않습니다."
}

if ($Mode -eq "GetPid") {
    $processId = [uint32] 0
    [void] [HanulE2E.NativeWindows]::GetWindowThreadProcessId([IntPtr] $ownerWindow.Current.NativeWindowHandle, [ref] $processId)
    if ($processId -eq 0) { throw "Could not identify the target Hanul window process." }
    Write-Output "Hanul window PID: $processId"
    exit 0
}

if ($Mode -eq "Close") {
    $ownerWindow.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
    Write-Output "Sent native close request to $OwnerTitle"
    exit 0
}

$until = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$dialog = $null
$ownerHandle = [IntPtr] $ownerWindow.Current.NativeWindowHandle
$lastPopup = "none"

while ([DateTime]::UtcNow -lt $until -and -not $dialog) {
    $popupHandle = [HanulE2E.NativeWindows]::GetWindow($ownerHandle, 6) # GW_ENABLEDPOPUP
    if ($popupHandle -ne [IntPtr]::Zero -and $popupHandle -ne $ownerHandle) {
        try {
            $candidate = [System.Windows.Automation.AutomationElement]::FromHandle($popupHandle)
            $lastPopup = "$($candidate.Current.Name) [$($candidate.Current.ClassName)]"
            if ($candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) {
                $dialog = $candidate
            }
        } catch {
            $lastPopup = "owned popup not exposed by UI Automation"
        }
    }
    if (-not $dialog) { Start-Sleep -Milliseconds 150 }
}

if (-not $dialog) {
    throw "대상 Hanul 창의 owned popup 대화상자를 $TimeoutSeconds 초 안에 찾지 못했습니다. 마지막 popup=$lastPopup"
}

$dialogName = $dialog.Current.Name
Write-Output "Found native dialog: $dialogName"

if ($CloseAppBeforeSelection) {
    $ownerWindow.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
    Write-Output "Sent close request while native file dialog was open"
    Start-Sleep -Milliseconds 200
}

if ($Mode -eq "Cancel") {
    $dialogHandle = [IntPtr] $dialog.Current.NativeWindowHandle
    $cancelHandle = [HanulE2E.NativeWindows]::FindChild($dialogHandle, 2, "Button")
    if ($cancelHandle -eq [IntPtr]::Zero) { throw "Target dialog's native Cancel control was not found: $dialogName" }
    [void] [HanulE2E.NativeWindows]::SendMessage($cancelHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) # BM_CLICK
    Write-Output "Cancelled native dialog"
    exit 0
}

if (-not $Path) { throw "Open/Save mode requires a path." }

$dialogHandle = [IntPtr] $dialog.Current.NativeWindowHandle
$filenameEditId = if ($Mode -eq "Open") { 1148 } else { 1001 }
$pathHandle = [HanulE2E.NativeWindows]::FindChild($dialogHandle, $filenameEditId, "Edit")
if ($pathHandle -eq [IntPtr]::Zero) { throw "Target dialog filename edit HWND was not found: $dialogName" }
# The common-dialog filename editor is a native EDIT HWND (id 1148 for Open,
# 1001 for Save), but UIA reports its host as a non-focusable Pane without
# ValuePattern. Set it natively, then independently read it back through UIA.
$setResult = [HanulE2E.NativeWindows]::SendMessageText($pathHandle, 0x000C, [IntPtr]::Zero, $Path) # WM_SETTEXT
Start-Sleep -Milliseconds 80
$refreshedField = [System.Windows.Automation.AutomationElement]::FromHandle($pathHandle)
$filenameText = $refreshedField.Current.Name
if ($setResult -eq [IntPtr]::Zero -or $filenameText -ne $Path) {
    throw "Filename field did not accept requested path. UIA value='$filenameText'"
}

$buttonPattern = if ($Mode -eq "Open") { "^\uC5F4\uAE30.*$|^Open$" } else { "^\uC800\uC7A5.*$|^Save$" }
$actionButton = $null
$descendants = $dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
)
foreach ($element in $descendants) {
    if ($element.Current.Name -match $buttonPattern -and
        $element.Current.Name -notmatch "\uB2E4\uB978 \uC774\uB984|Save As") {
        $actionButton = $element
        if ($element.Current.IsEnabled) { break }
    }
}
if (-not $actionButton) { throw "Expected confirm control not found in target dialog: $dialogName" }
$buttonHandle = [HanulE2E.NativeWindows]::FindChild($dialogHandle, 1, "Button")
if ($buttonHandle -eq [IntPtr]::Zero) { throw "Native confirm control was not found in target dialog: $dialogName" }
[void] [HanulE2E.NativeWindows]::SendMessage($buttonHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) # BM_CLICK
Write-Output "$Mode selected: $($filenameText.ToString()) via owned dialog '$dialogName'"
