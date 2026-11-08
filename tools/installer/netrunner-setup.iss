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
Type: dirifempty; Name: "{%USERPROFILE}\NETRUNNER\models"

[Code]
var
  ModelRel, ModelSha: array of String;
  ModelSize: array of Int64;
  ModelFirst, ModelCount: array of Integer;
  PartUrl, PartName, PartSha: array of String;
  PartSize: array of Int64;
  DownloadPage: TDownloadWizardPage;
  NeedGit: Boolean;

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
var p: String;
begin
  p := '';
  Result := (FileSearch('git.exe', GetEnv('PATH')) <> '')
    or FileExists(ExpandConstant('{localappdata}\Programs\Git\cmd\git.exe'))
    or FileExists(ExpandConstant('{commonpf64}\Git\cmd\git.exe'));
end;

function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

procedure AddModels; forward;

procedure InitializeWizard;
begin
  AddModels;
  DownloadPage := CreateDownloadPage('Загрузка моделей', 'NETRUNNER скачивает модели и проверяет каждый файл по SHA-256. Это может занять несколько часов — зависит от скорости интернета.', @OnDownloadProgress);
  DownloadPage.ShowBaseNameInsteadOfUrl := True;
end;

// Downloads one file into {tmp} (Inno checks its SHA-256). Three automatic attempts, then the user may retry or cancel.
function DownloadOne(Url, Name, Sha: String; Size: Int64; Title: String): Boolean;
var attempt: Integer;
begin
  Result := False;
  if SizeOf(ExpandConstant('{tmp}\') + Name) = Size then begin Result := True; Exit; end;
  attempt := 0;
  while not Result do begin
    attempt := attempt + 1;
    DownloadPage.Clear;
    DownloadPage.Add(Url, Name, Sha);
    DownloadPage.SetText(Title, Name);
    try
      DownloadPage.Download;
      Result := True;
    except
      Log('Download failed (' + IntToStr(attempt) + '): ' + Name + ': ' + GetExceptionMessage);
      if DownloadPage.AbortedByUser then Exit;
      if (attempt >= 3) and (SuppressibleMsgBox('Не удалось скачать ' + Name + ':' + #13#10 + GetExceptionMessage + #13#10#13#10 + 'Проверьте подключение к интернету и нажмите «Повтор».', mbError, MB_RETRYCANCEL, IDCANCEL) = IDCANCEL) then Exit;
    end;
  end;
end;

// Joins downloaded parts into one file in {tmp} and checks the result's SHA-256.
function JoinParts(i: Integer): Boolean;
var target, cmd: String; k, rc: Integer;
begin
  target := ExpandConstant('{tmp}\model') + IntToStr(i) + '.gguf';
  if SizeOf(target) = ModelSize[i] then begin Result := True; Exit; end;
  cmd := '/c copy /b ';
  for k := 0 to ModelCount[i] - 1 do begin
    if k > 0 then cmd := cmd + '+';
    cmd := cmd + '"' + ExpandConstant('{tmp}\') + PartName[ModelFirst[i] + k] + '"';
  end;
  cmd := cmd + ' "' + target + '" >nul';
  Result := Exec(ExpandConstant('{cmd}'), cmd, '', SW_HIDE, ewWaitUntilTerminated, rc) and (rc = 0)
    and (SizeOf(target) = ModelSize[i]) and (CompareText(GetSHA256OfFile(target), ModelSha[i]) = 0);
  if Result then
    for k := 0 to ModelCount[i] - 1 do DeleteFile(ExpandConstant('{tmp}\') + PartName[ModelFirst[i] + k])
  else
    Log('Join or SHA-256 check failed: ' + ModelRel[i]);
end;

function DownloadedPath(i: Integer): String;
begin
  if ModelCount[i] = 1 then Result := ExpandConstant('{tmp}\') + PartName[ModelFirst[i]]
  else Result := ExpandConstant('{tmp}\model') + IntToStr(i) + '.gguf';
end;

function DownloadAll: Boolean;
var i, k, total, done: Integer;
begin
  Result := False;
  total := 0;
  for i := 0 to GetArrayLength(ModelRel) - 1 do if not ModelInstalled(i) then total := total + 1;
  NeedGit := not GitPresent;
  if (total = 0) and not NeedGit then begin Result := True; Exit; end;
  DownloadPage.Show;
  try
    done := 0;
    for i := 0 to GetArrayLength(ModelRel) - 1 do begin
      if ModelInstalled(i) then Continue;
      done := done + 1;
      for k := 0 to ModelCount[i] - 1 do
        if not DownloadOne(PartUrl[ModelFirst[i] + k], PartName[ModelFirst[i] + k], PartSha[ModelFirst[i] + k], PartSize[ModelFirst[i] + k],
          'Модель ' + IntToStr(done) + ' из ' + IntToStr(total) + ': ' + ModelRel[i]) then Exit;
      if (ModelCount[i] > 1) and not JoinParts(i) then begin
        SuppressibleMsgBox('Файл модели ' + ModelRel[i] + ' собран с ошибкой. Запустите установку ещё раз.', mbError, MB_OK, IDOK);
        Exit;
      end;
    end;
    if NeedGit and not DownloadOne('{#GitUrl}', 'Git-setup.exe', '{#GitSha}', 0, 'Git for Windows (нужен агентам)') then Exit;
    Result := True;
  finally
    DownloadPage.Hide;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpReady then Result := DownloadAll;
end;

// Moves the downloaded models into place (same disk: a rename, no second copy) and installs Git when it was missing.
procedure CurStepChanged(CurStep: TSetupStep);
var i, rc: Integer; src, dst: String;
begin
  if CurStep <> ssPostInstall then Exit;
  for i := 0 to GetArrayLength(ModelRel) - 1 do begin
    if ModelInstalled(i) then Continue;
    src := DownloadedPath(i);
    dst := ModelsDir + '\' + ModelRel[i];
    WizardForm.StatusLabel.Caption := 'Установка модели ' + ModelRel[i];
    ForceDirectories(ExtractFileDir(dst));
    if FileExists(dst) then DeleteFile(dst);
    if not RenameFile(src, dst) then
      if FileCopy(src, dst, False) then DeleteFile(src);
    if not ModelInstalled(i) then
      SuppressibleMsgBox('Не удалось установить ' + ModelRel[i] + '. Запустите установку ещё раз — уже скачанное не будет скачиваться заново.', mbError, MB_OK, IDOK);
  end;
  if NeedGit and FileExists(ExpandConstant('{tmp}\Git-setup.exe')) then begin
    WizardForm.StatusLabel.Caption := 'Установка Git for Windows';
    Exec(ExpandConstant('{tmp}\Git-setup.exe'), '/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES /DIR="' + ExpandConstant('{localappdata}\Programs\Git') + '"', '', SW_HIDE, ewWaitUntilTerminated, rc);
    Log('Git setup exit code ' + IntToStr(rc));
  end;
end;

// The model list (Pascal calling AddModel/AddPart above) and its [UninstallDelete] entries.
#include "models.iss"
