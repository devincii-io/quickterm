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

[UninstallDelete]
; The backend copies of the user who uninstalls. InitializeUninstall below
; stops that user's backend first, after asking.
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
// itself: a launcher for a moment, a backend whose copy could not be made, the
// elevated instance (started from {app} on purpose, so an administrator process
// never loads from the user-writable copy), or a version before 4.2, where one
// process held the terminals and the window. Only then is the user asked.
//
// Every helper program runs by its absolute path from {sys}, with {sys} as the
// working folder: cmd.exe looks for a bare program name in the current folder
// first, which may be Downloads, and Setup may run elevated.
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
  if not Exec(ExpandConstant('{sys}\taskkill.exe'), Args, ExpandConstant('{sys}'), SW_HIDE,
              ewWaitUntilTerminated, ResultCode) then
    Result := -1
  else
    Result := ResultCode;
end;

// The tasklist/taskkill filter for the user running Setup or Uninstall.
function CurrentUserFilter(): String;
begin
  Result := '/FI "USERNAME eq ' + GetEnv('USERDOMAIN') + '\' + GetUserNameString() + '"';
end;

// True when a process with this image name runs (only the current user's with
// CurrentUserOnly). tasklist writes one CSV line per match into a file, which
// is read here: no `find`, and cmd.exe is only there for the redirection.
function ImageRunning(const Image: String; CurrentUserOnly: Boolean): Boolean;
var
  ResultCode: Integer;
  Listing, Filter: String;
  Output: AnsiString;
begin
  Result := False;
  Listing := AddBackslash(GetTempDir()) + 'quickterm-tasklist.txt';
  DeleteFile(Listing);
  Filter := '/FI "IMAGENAME eq ' + Image + '"';
  if CurrentUserOnly then
    Filter := Filter + ' ' + CurrentUserFilter();
  if not Exec(ExpandConstant('{cmd}'),
              '/C ""' + ExpandConstant('{sys}\tasklist.exe') + '" /NH /FO CSV ' + Filter
              + ' > "' + Listing + '""',
              ExpandConstant('{sys}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Exit;
  if LoadStringFromFile(Listing, Output) then
    Result := Pos('"' + Lowercase(Image) + '"', Lowercase(String(Output))) > 0;
  DeleteFile(Listing);
end;

// Uninstalling stops this user's backend and with it every terminal, so it is
// asked like an update that has to close QuickTerm. Other users' backends run
// from their own copies, hold nothing in {app}, and are none of this
// uninstaller's business.
function InitializeUninstall(): Boolean;
begin
  Result := True;
  if not (ImageRunning('QuickTerm-host.exe', True) or ImageRunning('{#AppExeName}', True)) then
    Exit;
  if not UninstallSilent() then
    if MsgBox('QuickTerm is being removed, so it has to close first.'
              + #13#10#13#10 + 'Terminals that are still open will be stopped.'
              + #13#10#13#10 + 'Close QuickTerm now and continue?',
              mbConfirmation, MB_YESNO) = IDNO then
    begin
      Result := False;
      Exit;
    end;
  TaskKill('/F ' + CurrentUserFilter() + ' /IM QuickTerm-host.exe');
  TaskKill('/F ' + CurrentUserFilter() + ' /IM {#AppExeName}');
  // Windows releases the image locks a moment after the process goes.
  Sleep(900);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  // The usual case since 4.2: only the backend copy runs, and it stays.
  if not ImageRunning('{#AppExeName}', False) then
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
