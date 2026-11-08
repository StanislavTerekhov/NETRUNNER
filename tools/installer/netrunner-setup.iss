; NETRUNNER one-click installer (published on GitHub Releases).
; One .exe holds the app, llama.cpp b12020 with the Visual C++ runtime it needs, and ripgrep. During installation it
; downloads every model (Hugging Face at pinned revisions; FORGE models from this project's GitHub release), checks
; each file's SHA-256, and installs Git for Windows for the current user when Git is missing. Nothing else to do.
;   node tools/installer/gen-models-iss.mjs
;   "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" /DAppVersion=1.9.3 tools\installer\netrunner-setup.iss
; Layout matches what the app expects:
;   app      → %LOCALAPPDATA%\Programs\NETRUNNER
;   runtime  → %USERPROFILE%\NETRUNNER\runtime\llama.cpp\b12020, %USERPROFILE%\NETRUNNER\runtime\ripgrep\rg.exe
;   models   → %USERPROFILE%\NETRUNNER\models

#ifndef AppVersion
  #error Pass /DAppVersion=<x.y.z>
#endif
#ifndef OutDir
  #define OutDir "..\..\release\" + AppVersion
#endif
#ifndef RgExe
  #define RgExe GetEnv("LOCALAPPDATA") + "\Microsoft\WinGet\Packages\BurntSushi.ripgrep.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe\ripgrep-15.2.0-x86_64-pc-windows-msvc\rg.exe"
#endif
#define Root "..\.."
#define Home GetEnv("USERPROFILE") + "\NETRUNNER"
; Git for Windows, official release; SHA-256 as published on its GitHub release.
#define GitUrl "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/Git-2.56.0.4-64-bit.exe"
#define GitSha "4961a4a8cc778d8b6e00a5819e5fe4d078b754555aff7aedc2d77a5d74c2de80"
#define GitSize "66850032"

#include "models-size.iss"

[Setup]
AppId={{8C1F3A52-6E0B-4D7B-9B7A-2F4E1C9D5A10}
AppName=NETRUNNER
AppVersion={#AppVersion}
AppVerName=NETRUNNER {#AppVersion}
AppPublisher=NETRUNNER
AppPublisherURL=https://github.com/StanislavTerekhov/NETRUNNER
DefaultDirName={localappdata}\Programs\NETRUNNER
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutDir}
OutputBaseFilename=NETRUNNER_Setup_{#AppVersion}
SetupIconFile={#Root}\build\icon.ico
UninstallDisplayIcon={app}\NETRUNNER.exe
UninstallDisplayName=NETRUNNER {#AppVersion}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
ExtraDiskSpaceRequired={#ModelsTotalBytes}
LicenseFile={#Root}\tools\installer\LICENSES-RU.txt
InfoBeforeFile={#Root}\tools\installer\README-SETUP-RU.txt
CloseApplications=yes

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#Root}\release\{#AppVersion}\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Home}\runtime\llama.cpp\b12020\*"; DestDir: "{%USERPROFILE}\NETRUNNER\runtime\llama.cpp\b12020"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Root}\build\crt\*.dll"; DestDir: "{%USERPROFILE}\NETRUNNER\runtime\llama.cpp\b12020"; Flags: ignoreversion
Source: "{#RgExe}"; DestDir: "{%USERPROFILE}\NETRUNNER\runtime\ripgrep"; Flags: ignoreversion
Source: "{#Root}\tools\installer\LICENSES-RU.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\NETRUNNER"; Filename: "{app}\NETRUNNER.exe"
Name: "{autodesktop}\NETRUNNER"; Filename: "{app}\NETRUNNER.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\NETRUNNER.exe"; Description: "{cm:LaunchProgram,NETRUNNER}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: dirifempty; Name: "{%USERPROFILE}\NETRUNNER\runtime\llama.cpp"
Type: dirifempty; Name: "{%USERPROFILE}\NETRUNNER\runtime\ripgrep"
Type: dirifempty; Name: "{%USERPROFILE}\NETRUNNER\runtime"
Type: filesandordirs; Name: "{%USERPROFILE}\NETRUNNER\models\.download"
Type: dirifempty; Name: "{%USERPROFILE}\NETRUNNER\models"

[Code]
var
  ModelRel, ModelSha: array of String;
  ModelSize: array of Int64;
  ModelFirst, ModelCount: array of Integer;
  PartUrl, PartName, PartSha: array of String;
  PartSize: array of Int64;
  Progress: TOutputProgressWizardPage;
  NeedGit: Boolean;

procedure Sleep(ms: LongWord); external 'Sleep@kernel32.dll stdcall';

procedure AddModel(Rel, Sha: String; Size: Int64);
var n: Integer;
begin
  n := GetArrayLength(ModelRel);
  SetArrayLength(ModelRel, n + 1); SetArrayLength(ModelSha, n + 1); SetArrayLength(ModelSize, n + 1);
  SetArrayLength(ModelFirst, n + 1); SetArrayLength(ModelCount, n + 1);
  ModelRel[n] := Rel; ModelSha[n] := Sha; ModelSize[n] := Size;
  ModelFirst[n] := GetArrayLength(PartUrl); ModelCount[n] := 0;
end;

procedure AddPart(Url, Name, Sha: String; Size: Int64);
var n, m: Integer;
begin
  n := GetArrayLength(PartUrl);
  SetArrayLength(PartUrl, n + 1); SetArrayLength(PartName, n + 1); SetArrayLength(PartSha, n + 1); SetArrayLength(PartSize, n + 1);
  PartUrl[n] := Url; PartName[n] := Name; PartSha[n] := Sha; PartSize[n] := Size;
  m := GetArrayLength(ModelRel) - 1;
  ModelCount[m] := ModelCount[m] + 1;
end;

function ModelsDir: String;
begin
  Result := ExpandConstant('{%USERPROFILE}\NETRUNNER\models');
end;

// Downloads live next to the models (same disk: moving a finished file is a rename) and survive a failed or
// cancelled run, so the next run resumes them instead of starting over.
function StagingDir: String;
begin
  Result := ModelsDir + '\.download';
end;

function SizeOf(Path: String): Int64;
var s: Int64;
begin
  if FileExists(Path) and FileSize64(Path, s) then Result := s else Result := -1;
end;

// A model counts as installed when the file is there with the right size (hashing 80 GB again would take minutes).
function ModelInstalled(i: Integer): Boolean;
begin
  Result := SizeOf(ModelsDir + '\' + ModelRel[i]) = ModelSize[i];
end;

function GitPresent: Boolean;
begin
  Result := (FileSearch('git.exe', GetEnv('PATH')) <> '')
    or FileExists(ExpandConstant('{localappdata}\Programs\Git\cmd\git.exe'))
    or FileExists(ExpandConstant('{commonpf64}\Git\cmd\git.exe'));
end;

procedure AddModels; forward;

procedure InitializeWizard;
begin
  AddModels;
  Progress := CreateOutputProgressPage('Загрузка моделей',
    'NETRUNNER скачивает модели и проверяет каждый файл по SHA-256. Это может занять от получаса до нескольких часов. ' +
    'Если закрыть установщик, при следующем запуске загрузка продолжится с того же места.');
end;

function Mb(Bytes: Int64): String;
begin
  Result := IntToStr(Bytes div 1048576) + ' МБ';
end;

// One curl.exe run (built into Windows 10 1803+): follows redirects, resumes a partial file (-C -) and gives up on a
// connection slower than 1 MB/s for 30 s, so the caller can reconnect: a stalled CDN route does not hold the install
// hostage. Shows the file growing while it runs. True when curl reported success.
function CurlOnce(Url, Target, Title: String; Size: Int64): Boolean;
var marker, line: String; rc, ticks: Integer; got, prev: Int64; ans: AnsiString;
begin
  marker := Target + '.done';
  DeleteFile(marker);
  line := '/c ""' + ExpandConstant('{sys}\curl.exe') + '" -L --fail -sS -C - --connect-timeout 30 --speed-limit 1000000 --speed-time 30 -o "' +
    Target + '" "' + Url + '" && (echo ok>"' + marker + '") || (echo fail>"' + marker + '")"';
  if not Exec(ExpandConstant('{cmd}'), line, '', SW_HIDE, ewNoWait, rc) then begin Result := False; Exit; end;
  prev := SizeOf(Target);
  if prev < 0 then prev := 0;
  ticks := 0;
  while not FileExists(marker) do begin
    Sleep(250);
    ticks := ticks + 1;
    got := SizeOf(Target);
    if got < 0 then got := 0;
    if Size > 0 then Progress.SetProgress(Integer((got * 1000) div Size), 1000);
    if ticks mod 8 = 0 then begin
      Progress.SetText(Title, Mb(got) + ' из ' + Mb(Size) + ' · ' + IntToStr(((got - prev) div 2) div 1048576) + ' МБ/с');
      prev := got;
    end;
  end;
  Sleep(200);
  Result := LoadStringFromFile(marker, ans) and (Pos('ok', String(ans)) > 0);
  DeleteFile(marker);
end;

// Downloads Url to Target until it has Size bytes and the right SHA-256. Reconnects and resumes on its own; after
// many failed attempts in a row the user may retry or cancel (cancel keeps the partial file for the next run).
function DownloadFile(Url, Target, Sha: String; Size: Int64; Title: String): Boolean;
var attempts: Integer;
begin
  Result := False;
  attempts := 0;
  while True do begin
    if SizeOf(Target) = Size then begin
      Progress.SetText(Title, 'Проверка SHA-256…');
      Progress.SetProgress(1000, 1000);
      if CompareText(GetSHA256OfFile(Target), Sha) = 0 then begin Result := True; Exit; end;
      Log('SHA-256 mismatch, downloading again: ' + Target);
      DeleteFile(Target);
    end;
    if SizeOf(Target) > Size then DeleteFile(Target);
    if not CurlOnce(Url, Target, Title, Size) then begin
      attempts := attempts + 1;
      Log('curl attempt ' + IntToStr(attempts) + ' ended at ' + IntToStr(SizeOf(Target)) + ' of ' + IntToStr(Size) + ' bytes: ' + Target);
      if attempts mod 20 = 0 then
        if SuppressibleMsgBox('Не удаётся скачать ' + ExtractFileName(Target) + '.' + #13#10#13#10 +
          'Проверьте подключение к интернету и нажмите «Повтор». Уже скачанное сохранится.', mbError, MB_RETRYCANCEL, IDCANCEL) = IDCANCEL then Exit;
      Sleep(2000);
    end;
  end;
end;

function MoveInto(Src, Dst: String): Boolean;
begin
  ForceDirectories(ExtractFileDir(Dst));
  if FileExists(Dst) then DeleteFile(Dst);
  Result := RenameFile(Src, Dst);
  if not Result and FileCopy(Src, Dst, False) then Result := DeleteFile(Src);
end;

// Downloads one model (its parts), joins parts, checks the SHA-256 of the whole and puts it in place right away.
function InstallModel(i: Integer; Title: String): Boolean;
var k, rc: Integer; joined, cmd: String;
begin
  Result := False;
  for k := 0 to ModelCount[i] - 1 do
    if not DownloadFile(PartUrl[ModelFirst[i] + k], StagingDir + '\' + PartName[ModelFirst[i] + k], PartSha[ModelFirst[i] + k],
      PartSize[ModelFirst[i] + k], Title + ' (' + IntToStr(k + 1) + '/' + IntToStr(ModelCount[i]) + ')') then Exit;
  if ModelCount[i] = 1 then
    joined := StagingDir + '\' + PartName[ModelFirst[i]]
  else begin
    joined := StagingDir + '\joined.gguf';
    Progress.SetText(Title, 'Сборка частей и проверка SHA-256…');
    cmd := '/c copy /b ';
    for k := 0 to ModelCount[i] - 1 do begin
      if k > 0 then cmd := cmd + '+';
      cmd := cmd + '"' + StagingDir + '\' + PartName[ModelFirst[i] + k] + '"';
    end;
    cmd := cmd + ' "' + joined + '" >nul';
    if not (Exec(ExpandConstant('{cmd}'), cmd, '', SW_HIDE, ewWaitUntilTerminated, rc) and (rc = 0)
      and (SizeOf(joined) = ModelSize[i]) and (CompareText(GetSHA256OfFile(joined), ModelSha[i]) = 0)) then begin
      Log('Join or SHA-256 check failed: ' + ModelRel[i]);
      DeleteFile(joined);
      for k := 0 to ModelCount[i] - 1 do DeleteFile(StagingDir + '\' + PartName[ModelFirst[i] + k]);
      SuppressibleMsgBox('Файл модели ' + ModelRel[i] + ' собран с ошибкой. Запустите установку ещё раз.', mbError, MB_OK, IDOK);
      Exit;
    end;
    for k := 0 to ModelCount[i] - 1 do DeleteFile(StagingDir + '\' + PartName[ModelFirst[i] + k]);
  end;
  Result := MoveInto(joined, ModelsDir + '\' + ModelRel[i]) and ModelInstalled(i);
  if not Result then Log('Could not move ' + joined + ' into place');
end;

function DownloadAll: Boolean;
var i, total, done: Integer;
begin
  Result := False;
  total := 0;
  for i := 0 to GetArrayLength(ModelRel) - 1 do if not ModelInstalled(i) then total := total + 1;
  NeedGit := not GitPresent;
  if (total = 0) and not NeedGit then begin Result := True; Exit; end;
  if not FileExists(ExpandConstant('{sys}\curl.exe')) then begin
    SuppressibleMsgBox('В этой Windows нет curl.exe (есть начиная с Windows 10 1803). Обновите Windows и запустите установку снова.', mbError, MB_OK, IDOK);
    Exit;
  end;
  ForceDirectories(StagingDir);
  Progress.Show;
  try
    done := 0;
    for i := 0 to GetArrayLength(ModelRel) - 1 do begin
      if ModelInstalled(i) then Continue;
      done := done + 1;
      if not InstallModel(i, 'Модель ' + IntToStr(done) + ' из ' + IntToStr(total) + ': ' + ExtractFileName(ModelRel[i])) then Exit;
    end;
    if NeedGit and not DownloadFile('{#GitUrl}', StagingDir + '\Git-setup.exe', '{#GitSha}', {#GitSize}, 'Git for Windows (нужен агентам)') then Exit;
    Result := True;
  finally
    Progress.Hide;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpReady then Result := DownloadAll;
end;

// After the files are in place: Git for Windows for the current user when it was missing; the empty staging folder
// goes away.
procedure CurStepChanged(CurStep: TSetupStep);
var rc: Integer; git: String;
begin
  if CurStep <> ssPostInstall then Exit;
  git := StagingDir + '\Git-setup.exe';
  if NeedGit and FileExists(git) then begin
    WizardForm.StatusLabel.Caption := 'Установка Git for Windows';
    Exec(git, '/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES /DIR="' + ExpandConstant('{localappdata}\Programs\Git') + '"', '', SW_HIDE, ewWaitUntilTerminated, rc);
    Log('Git setup exit code ' + IntToStr(rc));
    DeleteFile(git);
  end;
  RemoveDir(StagingDir);
end;

// The model list (Pascal calling AddModel/AddPart above) and its [UninstallDelete] entries.
#include "models.iss"
