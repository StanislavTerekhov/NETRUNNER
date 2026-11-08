; NETRUNNER offline installer: the app, the llama.cpp runtime (with the Visual C++ runtime DLLs it needs) and the
; local models — nothing is downloaded during or after installation.
;   "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" /DAppVersion=1.9.2 /DOutDir=D:\NETRUNNER-Installer tools\installer\netrunner-offline.iss
; Output: NETRUNNER_Setup_Offline_<version>.exe plus data parts NETRUNNER_Setup_Offline_<version>-N.bin (≈2 GB each,
; Inno Setup's slice limit) — all in one folder; the user runs the .exe.
; Install layout matches what the app expects:
;   app      → %LOCALAPPDATA%\Programs\NETRUNNER
;   runtime  → %USERPROFILE%\NETRUNNER\runtime\llama.cpp\b12020
;   models   → %USERPROFILE%\NETRUNNER\models

#ifndef AppVersion
  #error Pass /DAppVersion=<x.y.z>
#endif
#ifndef OutDir
  #define OutDir "..\..\release\offline"
#endif
#define Root "..\.."
#define Home GetEnv("USERPROFILE") + "\NETRUNNER"
#define Crt "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Redist\MSVC\14.44.35112\x64\Microsoft.VC143.CRT"

[Setup]
AppId={{8C1F3A52-6E0B-4D7B-9B7A-2F4E1C9D5A10}
AppName=NETRUNNER
AppVersion={#AppVersion}
AppVerName=NETRUNNER {#AppVersion}
AppPublisher=NETRUNNER
DefaultDirName={localappdata}\Programs\NETRUNNER
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutDir}
OutputBaseFilename=NETRUNNER_Setup_Offline_{#AppVersion}
SetupIconFile={#Root}\build\icon.ico
UninstallDisplayIcon={app}\NETRUNNER.exe
UninstallDisplayName=NETRUNNER {#AppVersion} (offline)
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=no
DiskSpanning=yes
DiskSliceSize=2100000000
LicenseFile={#Root}\tools\installer\LICENSES-RU.txt
InfoBeforeFile={#Root}\tools\installer\README-RU.txt

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; The app (Electron, OpenCode, pyright, FORGE scripts) — the same files as the regular installer.
Source: "{#Root}\release\{#AppVersion}\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; llama.cpp b12020 (CUDA 13 + CPU backends) and the Visual C++ 2015–2022 runtime it links against, app-local.
Source: "{#Home}\runtime\llama.cpp\b12020\*"; DestDir: "{%USERPROFILE}\NETRUNNER\runtime\llama.cpp\b12020"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Crt}\msvcp140.dll"; DestDir: "{%USERPROFILE}\NETRUNNER\runtime\llama.cpp\b12020"; Flags: ignoreversion
Source: "{#Crt}\vcruntime140.dll"; DestDir: "{%USERPROFILE}\NETRUNNER\runtime\llama.cpp\b12020"; Flags: ignoreversion
Source: "{#Crt}\vcruntime140_1.dll"; DestDir: "{%USERPROFILE}\NETRUNNER\runtime\llama.cpp\b12020"; Flags: ignoreversion
; Models (GGUF does not compress: stored as is). Hugging Face download caches are left out.
Source: "{#Home}\models\*"; DestDir: "{%USERPROFILE}\NETRUNNER\models"; Excludes: ".cache"; Flags: ignoreversion recursesubdirs createallsubdirs nocompression
Source: "{#Root}\tools\installer\LICENSES-RU.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\NETRUNNER"; Filename: "{app}\NETRUNNER.exe"
Name: "{autodesktop}\NETRUNNER"; Filename: "{app}\NETRUNNER.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\NETRUNNER.exe"; Description: "{cm:LaunchProgram,NETRUNNER}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: dirifempty; Name: "{%USERPROFILE}\NETRUNNER\runtime\llama.cpp"
Type: dirifempty; Name: "{%USERPROFILE}\NETRUNNER\runtime"
