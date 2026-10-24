#ifndef AppVersion
  #error AppVersion is required; build with /DAppVersion=<version>
#endif

#define AppName "QuickTerm"
#define AppPublisher "Devin Isaac Worbis"
#define AppUrl "https://github.com/devincii-io/quickterm"
#define AppExeName "QuickTerm.exe"

[Setup]
AppId={{6B44DB88-0701-4953-AF24-73FD7DD546C9}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases/latest
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist
OutputBaseFilename=QuickTerm-v{#AppVersion}-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\quickterm\resources\quickterm.ico
UninstallDisplayIcon={app}\{#AppExeName}
CloseApplications=yes
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "contextmenu"; Description: "Add ""Open QuickTerm here"" to the folder right-click menu"; GroupDescription: "Explorer integration:"

[InstallDelete]
; Up to 3.11 the ConPTY host lived in the pywinpty package folder, next to
; winpty files nothing uses any more. An update would leave it behind.
Type: filesandordirs; Name: "{app}\_internal\winpty"

[Files]
Source: "..\dist\QuickTerm\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; "Open QuickTerm here" right-click entry on a folder. %V is the folder path, passed
; to the exe which opens its first terminal there (per-user, HKCU).
Root: HKCU; Subkey: "Software\Classes\Directory\shell\QuickTerm"; ValueType: string; ValueName: ""; ValueData: "Open QuickTerm here"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\shell\QuickTerm"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\{#AppExeName}"; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\shell\QuickTerm\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%V"""; Tasks: contextmenu
; And when right-clicking the empty background inside an open folder.
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\QuickTerm"; ValueType: string; ValueName: ""; ValueData: "Open QuickTerm here"; Flags: uninsdeletekey; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\QuickTerm"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\{#AppExeName}"; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\QuickTerm\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%V"""; Tasks: contextmenu

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; The new launcher finds the running backend. When it is an older build it is
; replaced at once if no terminal is busy or touched; otherwise the launcher
; asks, and a declined restart keeps the old backend until nothing is at risk.
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; The backend and its windows run from a copy under the host folder below, as
; QuickTerm-host.exe, so the uninstaller has to stop them by that name.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM QuickTerm-host.exe"; Flags: runhidden; RunOnceId: "StopQuickTermHost"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM {#AppExeName}"; Flags: runhidden; RunOnceId: "StopQuickTerm"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\QuickTerm\host"

[Code]
// ------------------------------------------------------------------------
// Closing a running QuickTerm before overwriting it.
//
// Since 4.2 the backend that owns the terminals does not run from {app}: the
// launcher copies the program to %LOCALAPPDATA%\QuickTerm\host\<build> and
// starts it there as QuickTerm-host.exe, together with its window process.
// Nothing of it holds a lock in {app}, and nothing here kills it, so an update
// leaves every terminal running. What can still hold {app} is QuickTerm.exe
// itself: a launcher for a moment, a backend that could not be copied and runs
// in place, the elevated instance, or a version before 4.2, where one process
// held the terminals and the window. Only then is the user asked.
//
// CloseApplications=yes alone does not close those. Before 4.2 the Restart
// Manager's request landed in the close-to-tray policy, which CANCELS the close
// whenever a session is touched, retained or busy, and Setup then stalled on
// "the following applications are in use" or force-terminated the process.
//
// Asked, not assumed: closing someone's terminals without warning is worse
// than a failed install. Declining is a clean abort, not a half-written
// directory.
//
// NO /T. That flag kills the target's whole process tree. An installer started
// from inside QuickTerm by the in-app updater would be standing in that tree,
// so Setup would be terminated by its own cleanup. update.py now starts the
// installer through `cmd /c start` so it has no live ancestor, but this script
// also has to survive being run from a terminal *inside* QuickTerm, which no
// amount of care on the update path can prevent. Killing by image name reaches
// every copy of the app, which is what holds the lock on QuickTerm.exe.
//
// The pseudoconsole hosts (conpty\OpenConsole.exe) and the bundled PuTTY tools
// are NOT killed by name. They live in {app} and do hold locks, but those image
// names are shared with other software (Windows Terminal ships OpenConsole.exe)
// and killing them by name would reach processes that are none of our business.
// They exit with the app that owns their pipes; the verify step below is what
// catches the case where they do not.
// ------------------------------------------------------------------------

function TaskKill(const Args: String): Integer;
var
  ResultCode: Integer;
begin
  if not Exec(ExpandConstant('{sys}\taskkill.exe'), Args, '', SW_HIDE,
              ewWaitUntilTerminated, ResultCode) then
    Result := -1
  else
    Result := ResultCode;
end;

// True when a process with this image name runs. tasklist prints a header-less
// line per match; find answers 0 when it saw one.
function ImageRunning(const Image: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'),
                 '/C tasklist /FI "IMAGENAME eq ' + Image + '" /NH | find /I "' + Image + '" >NUL',
                 '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  // The usual case since 4.2: only the backend copy runs, and it stays.
  if not ImageRunning('{#AppExeName}') then
    Exit;
  if not WizardSilent() then
    if MsgBox('QuickTerm is being replaced, so any running copy has to close first.'
              + #13#10#13#10 + 'Terminals that are still open will be stopped.'
              + #13#10#13#10 + 'Close QuickTerm now and continue?',
              mbConfirmation, MB_YESNO) = IDNO then
    begin
      Result := 'Setup was cancelled: QuickTerm has to be closed before it can be updated.';
      Exit;
    end;

  TaskKill('/F /IM QuickTerm.exe');
  // Windows releases the image locks a moment after the process goes.
  Sleep(900);

  // Verify rather than hope. taskkill answers 128 for "no such process", which
  // is the outcome we want; anything else means a copy survived the kill. The
  // usual reason is an elevated QuickTerm window, which this per-user installer
  // genuinely cannot touch, so say that instead of failing later on a locked
  // file with no explanation.
  Code := TaskKill('/F /IM QuickTerm.exe');
  if Code <> 128 then
  begin
    if WizardSilent() then
      Result := 'A running QuickTerm could not be closed. If it was started as administrator, close it and run this installer again.'
    else
      if MsgBox('A running QuickTerm could not be closed. This usually means a window is running as administrator, which this installer cannot close.'
                + #13#10#13#10 + 'Close it yourself, then press Retry.',
                mbError, MB_RETRYCANCEL) = IDRETRY then
      begin
        Sleep(400);
        if TaskKill('/F /IM QuickTerm.exe') <> 128 then
          Result := 'QuickTerm is still running. Close it and run this installer again.';
      end
      else
        Result := 'Setup was cancelled: QuickTerm is still running.';
  end;
end;
