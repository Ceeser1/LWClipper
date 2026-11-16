; Self-extracting launcher that unpacks once instead of every time.
;
; electron-builder's own portable target cannot do this: its template wipes the
; unpack folder before extracting and again when the app exits, both
; unconditionally, and the portable target reads that template straight off disk
; with no way to substitute one. So the app is built as a plain folder and this
; wraps it.
;
; First run extracts to %LOCALAPPDATA%\LWClipper\runtime-<version> and leaves it
; there. Every run after that finds the marker and goes straight to launching,
; which is the whole point. Sitting beside the app's own data folder rather than
; in TEMP is what keeps it from being swept by a disk cleanup between runs.
;
; A splash covers the whole wait, first run or not, and comes down when the app's
; own window appears. See ShowSplash for why it is built the way it is.
;
; V4.11.3. It is also the installer: "LWC should have 2 options: Stand-alone
; and installer .exe", in one file. electron-builder's Setup.exe rides inside
; it, and the first start of a version that has no file to open asks which one
; is wanted. See ChoicePage. Once this version's runtime is unpacked the
; question has been answered with "run", so every start after that goes
; straight to the app exactly as it did before there was a question.
;
; Built by scripts/build-launcher.js, which supplies every define below.

Unicode true
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

!ifndef VERSION
  !error "VERSION must be defined"
!endif
!ifndef APPDIR
  !error "APPDIR must be defined"
!endif
!ifndef OUTFILE
  !error "OUTFILE must be defined"
!endif
!ifndef SPLASH
  !error "SPLASH must be defined"
!endif
!ifndef SPLASH_W
  !error "SPLASH_W must be defined"
!endif
!ifndef SPLASH_H
  !error "SPLASH_H must be defined"
!endif
!ifndef WINDOWTITLE
  !error "WINDOWTITLE must be defined"
!endif
!ifndef SETUP
  !error "SETUP must be defined"
!endif

Name "LWClipper"
OutFile "${OUTFILE}"
Caption "LWClipper ${VERSION}"
BrandingText " "
; Common controls 6, which is what draws the two choices as command links.
XPStyle on

; No elevation: everything it writes is under the user's own profile. The
; installer it carries asks for administrator rights itself, and only when
; "Install" is picked.
RequestExecutionLevel user
; Measured: with this on, every launch spends about 8 seconds CRC-checking the
; whole 146MB archive before it does anything, which swamped the saving from
; caching the runtime and made the cached path slower than extracting. The stub
; is read off local disk and a corrupt one fails at extraction anyway.
; electron-builder's own portable template turns it off for the same reason.
CRCCheck off
AutoCloseWindow True
; No SilentInstall here: .onInit decides at run time. The window only ever
; shows the question; on every other start the splash is the only thing seen.
;
; Two decisions here, both measured on the same machine over the same 482MB of
; payload, timed from double-click to the app's window being on screen:
;
;                          file     first run   every run after
;   lzma /SOLID            137MB      6.5s        6.5s, always
;   lzma non-solid         151MB     14.2s        0.6s
;   bzip2 non-solid        185MB     17.5s        0.6s
;   zlib non-solid         199MB      4.9s        0.6s
;
; Not /SOLID, and that is the whole reason this launcher is worth having. A
; solid archive is one stream that cannot be seeked, so NSIS decompresses all of
; it before it can do anything at all, even on a launch that reads nothing out.
; That was 14 seconds on every launch with the runtime already unpacked, which
; defeats the entire point. Non-solid lets a cached run touch none of the
; payload, splash bitmap aside.
;
; zlib rather than lzma because non-solid lzma turned out to decompress about
; twice as slowly as solid lzma over the same bytes, and I never worked out why:
; it is not per-file overhead, the payload is 78 files. zlib sidesteps it and
; makes even the first run quicker than the old portable ever managed, at 48MB
; more to download. bzip2 is listed only to record that it is worse at both.
SetCompressor /FINAL zlib

; After SetCompressor, which has to come before anything that stores data.
!ifdef ICON
  !define MUI_ICON "${ICON}"
!endif
!include "MUI2.nsh"

Page custom ChoicePage ChoiceLeave
; Never reached: ChoiceLeave either quits or stays on its own page. MUI wants
; one page of its own ahead of MUI_LANGUAGE and warns on every build without.
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "German"

; The window speaks the language Windows does, German or else English. The app
; has its own language setting, but that lives in a JSON file this has no way
; to read before the app has ever run.
LangString ChoiceTitle    ${LANG_ENGLISH} "How do you want to start LWClipper?"
LangString ChoiceTitle    ${LANG_GERMAN}  "Wie soll LWClipper starten?"
LangString ChoiceSubtitle ${LANG_ENGLISH} "Version ${VERSION} can be installed, or run straight from this file."
LangString ChoiceSubtitle ${LANG_GERMAN}  "Version ${VERSION} kann installiert werden oder direkt aus dieser Datei laufen."
LangString InstallLabel   ${LANG_ENGLISH} "Install LWClipper"
LangString InstallLabel   ${LANG_GERMAN}  "LWClipper installieren"
LangString InstallNote    ${LANG_ENGLISH} "Into Program Files unless you pick another folder, with Start menu and desktop shortcuts and an uninstaller. A double-click on a .lwc project opens it. Asks for administrator rights."
LangString InstallNote    ${LANG_GERMAN}  "Nach Programme, wenn kein anderer Ordner gewählt wird, mit Verknüpfungen im Startmenü und auf dem Desktop und einem Deinstallationsprogramm. Ein Doppelklick auf ein .lwc-Projekt öffnet es. Fragt nach Administratorrechten."
LangString RunLabel       ${LANG_ENGLISH} "Run without installing"
LangString RunLabel       ${LANG_GERMAN}  "Ohne Installation starten"
LangString RunNote        ${LANG_ENGLISH} "Starts LWClipper from this file. Nothing is installed and .lwc files are not registered. Asked only on the first start of this version; after that it goes straight to the app."
LangString RunNote        ${LANG_GERMAN}  "Startet LWClipper aus dieser Datei. Es wird nichts installiert und .lwc-Dateien werden nicht registriert. Die Frage kommt nur beim ersten Start dieser Version, danach geht es direkt in die App."
LangString Preparing      ${LANG_ENGLISH} "Preparing the installer..."
LangString Preparing      ${LANG_GERMAN}  "Das Installationsprogramm wird vorbereitet..."
LangString NotStarted     ${LANG_ENGLISH} "The installer did not start. Pick again, or close this window."
LangString NotStarted     ${LANG_GERMAN}  "Das Installationsprogramm wurde nicht gestartet. Erneut wählen oder dieses Fenster schließen."

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "LWClipper"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Lightweight clipper for local files and video links"
VIAddVersionKey "CompanyName" "Ceeser"
VIAddVersionKey "LegalCopyright" ""

; Win32 names, so the System::Call lines below read as something other than
; a wall of hex. /ifndef because nsDialogs.nsh defines some of them already,
; with the same values.
!define /ifndef GWL_STYLE        -16
!define /ifndef GWL_EXSTYLE      -20
!define SPLASH_STYLE     0x90000000 ; WS_POPUP | WS_VISIBLE
; Topmost and nothing else. What a dialog carries otherwise is WS_EX_WINDOWEDGE
; and WS_EX_DLGMODALFRAME, which draw a raised white edge down the right and
; along the bottom of a window that is meant to be a plain picture.
!define SPLASH_EXSTYLE   0x00000008 ; WS_EX_TOPMOST
!define PICTURE_STYLE    0x5000000E ; WS_CHILD | WS_VISIBLE | SS_BITMAP
!define SWP_FRAME_SHOW   0x00000060 ; SWP_FRAMECHANGED | SWP_SHOWWINDOW
!define SWP_FRAME_KEEPZ  0x00000024 ; SWP_FRAMECHANGED | SWP_NOZORDER
!define /ifndef HWND_TOPMOST     -1
!define /ifndef LR_LOADFROMFILE  0x00000010
!define /ifndef STM_SETIMAGE     0x00000172
!define /ifndef IMAGE_BITMAP     0
!define IDC_STR          1030       ; the one control on Banner's dialog
!define /ifndef SM_CXSCREEN      0
!define /ifndef SM_CYSCREEN      1
; Corner rounding, as the width and height of the ellipse CreateRoundRectRgn
; draws the corners from, which is twice the radius. 80 is a 40px radius on a
; 400x280 card, which is plainly round rather than merely softened. Passing the
; radius here instead of the ellipse is the easy mistake: 14 looked square
; because it produced a 7px curve.
!define CORNER           80
; A tenth of a second a turn, for ten seconds. Long enough for a cold start on a
; slow disk, short enough that a splash left behind by something unforeseen is a
; brief annoyance rather than a stuck window.
!define WAIT_TRIES       100
!define WAIT_STEP        100

!define /ifndef BS_COMMANDLINK   0x0000000E
!define /ifndef BCM_SETNOTE      0x00001609
!define /ifndef WM_NOTIFY_OUTER_NEXT 0x00000408

Var ChoiceDialog
Var InstallButton
Var RunButton
Var ChoiceStatus
; "install", "run", or empty while nothing has been picked.
Var Choice

; The question is asked only when it can matter: not when this version is
; already unpacked, since that means "run" was picked before, and not when the
; app is being handed a file to open (a .lwc dropped on the exe, or a command
; line), since that is somebody using the app rather than starting it fresh.
Function .onInit
  ${GetParameters} $R0
  ${If} ${FileExists} "$LOCALAPPDATA\LWClipper\runtime-${VERSION}\.ready"
  ${OrIf} $R0 != ""
    SetSilent silent
  ${Else}
    SetSilent normal
  ${EndIf}
FunctionEnd

; Only reached silently. A start that asks finishes inside ChoiceLeave.
Section
  Call StartApp
SectionEnd

; Two command links, the same kind of choice Windows itself offers, rather than
; a Yes/No box whose buttons cannot say what they do. The Next button would only
; repeat them, so it is hidden; Cancel stays as the way out.
Function ChoicePage
  !insertmacro MUI_HEADER_TEXT "$(ChoiceTitle)" "$(ChoiceSubtitle)"
  nsDialogs::Create 1018
  Pop $ChoiceDialog
  ${If} $ChoiceDialog == error
    Abort
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}

  nsDialogs::CreateControl BUTTON ${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${BS_COMMANDLINK} 0 \
    0 2u 100% 50u "$(InstallLabel)"
  Pop $InstallButton
  SendMessage $InstallButton ${BCM_SETNOTE} 0 "STR:$(InstallNote)"
  ; The shield says up front that this one asks for administrator rights.
  SendMessage $InstallButton ${BCM_SETSHIELD} 0 1
  ${NSD_OnClick} $InstallButton OnInstallClick

  nsDialogs::CreateControl BUTTON ${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${BS_COMMANDLINK} 0 \
    0 58u 100% 50u "$(RunLabel)"
  Pop $RunButton
  SendMessage $RunButton ${BCM_SETNOTE} 0 "STR:$(RunNote)"
  ${NSD_OnClick} $RunButton OnRunClick

  ${NSD_CreateLabel} 0 114u 100% 12u ""
  Pop $ChoiceStatus

  StrCpy $Choice ""
  nsDialogs::Show
FunctionEnd

Function OnInstallClick
  StrCpy $Choice "install"
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

Function OnRunClick
  StrCpy $Choice "run"
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

; Enter on the page with nothing picked lands here too, and does nothing.
Function ChoiceLeave
  ${If} $Choice == "run"
    HideWindow
    Call StartApp
    Quit
  ${ElseIf} $Choice == "install"
    Call RunSetup
    ; Only back here when the installer never started, most likely because the
    ; administrator prompt was turned down. The page stays so the other choice
    ; is still there.
    Abort
  ${Else}
    Abort
  ${EndIf}
FunctionEnd

; electron-builder's installer, carried whole. It is a separate program with
; its own pages, so it is unpacked to the plugins folder and run there, and this
; waits for it: the folder is removed when this exits, and removing it under a
; running installer would fail and leave 150MB behind in TEMP.
;
; Nothing is unpacked into the runtime folder on this path, so a later start of
; this same file asks again, which is what makes a reinstall possible.
Function RunSetup
  EnableWindow $InstallButton 0
  EnableWindow $RunButton 0
  ${NSD_SetText} $ChoiceStatus "$(Preparing)"
  System::Call 'user32::UpdateWindow(p $HWNDPARENT)'

  InitPluginsDir
  File "/oname=$PLUGINSDIR\LWClipper Setup.exe" "${SETUP}"

  HideWindow
  ClearErrors
  ExecShellWait "open" "$PLUGINSDIR\LWClipper Setup.exe"
  ${IfNot} ${Errors}
    Quit
  ${EndIf}

  ShowWindow $HWNDPARENT ${SW_SHOW}
  BringToFront
  EnableWindow $InstallButton 1
  EnableWindow $RunButton 1
  ${NSD_SetText} $ChoiceStatus "$(NotStarted)"
  StrCpy $Choice ""
FunctionEnd

; $R1 the app's folder, $R2 this version's runtime inside it.
; $R3 the splash window, $R4 its bitmap, $R5 the control drawing it.
Function StartApp
  Call ShowSplash

  StrCpy $R1 "$LOCALAPPDATA\LWClipper"
  StrCpy $R2 "$R1\runtime-${VERSION}"

  ; The marker is written last, so a run interrupted part way through leaves no
  ; marker and the next one starts over rather than launching half an app.
  IfFileExists "$R2\.ready" launch

  ; Whatever is there is either a failed extraction or a different build that
  ; happens to share the version. Neither is worth merging into.
  RMDir /r "$R2"
  CreateDirectory "$R2"
  SetOutPath "$R2"
  File /r "${APPDIR}\*.*"

  FileOpen $0 "$R2\.ready" w
  FileWrite $0 "${VERSION}"
  FileClose $0

  ; A new version's first run is also the moment the old one stops being needed.
  Call RemoveOldRuntimes

launch:
  ; The app reads these to find where the .exe really lives, which is not where
  ; it is running from. Without them the download cache would be created inside
  ; the runtime folder instead of beside the executable.
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "LWClipper").r0'

  ${GetParameters} $R0
  ; Start the app in the folder the user launched from, not in the runtime.
  SetOutPath "$EXEDIR"
  ; Exec rather than ExecWait: nothing here needs to outlive the launch beyond
  ; handing the screen over to the app's own window.
  Exec '"$R2\LWClipper.exe" $R0'

  Call HideSplash
FunctionEnd

; A picture on screen for the whole wait, which on a first run is fifteen
; seconds of nothing at all otherwise.
;
; Banner rather than Splash or AdvSplash: those two run their message loop on
; the calling thread, so they block for a fixed delay and then go, which is the
; opposite of what is wanted here. Banner puts its window on a thread of its own
; and returns, so it stays up and stays repainting while the extraction below
; blocks the main thread.
;
; What Banner gives is a small captioned dialog with one text control. The calls
; below turn that into a borderless window the size of the bitmap with the
; bitmap in it: the control is restyled to draw an image, the image is handed to
; it, and the dialog loses its frame and is centred. If the bitmap fails to load
; none of that happens and the plain dialog is left showing the app's name,
; which is worse looking but still says something is happening.
Function ShowSplash
  InitPluginsDir
  File /oname=$PLUGINSDIR\splash.bmp "${SPLASH}"

  Banner::show /NOUNLOAD /set ${IDC_STR} "LWClipper" "LWClipper"
  Banner::getWindow /NOUNLOAD
  Pop $R3

  System::Call 'user32::LoadImage(i 0, t "$PLUGINSDIR\splash.bmp", i ${IMAGE_BITMAP}, \
    i 0, i 0, i ${LR_LOADFROMFILE}) i .R4'
  IntCmp $R4 0 done

  System::Call 'user32::GetDlgItem(i $R3, i ${IDC_STR}) i .R5'
  System::Call 'user32::SetWindowLong(i $R5, i ${GWL_STYLE}, i ${PICTURE_STYLE})'
  System::Call 'user32::SendMessage(i $R5, i ${STM_SETIMAGE}, i ${IMAGE_BITMAP}, i $R4)'
  System::Call 'user32::SetWindowPos(i $R5, i 0, i 0, i 0, i ${SPLASH_W}, i ${SPLASH_H}, \
    i ${SWP_FRAME_KEEPZ})'

  ; Centred on the primary screen rather than the work area: a splash sits over
  ; the taskbar happily and the middle of the screen is where an eye goes.
  System::Call 'user32::GetSystemMetrics(i ${SM_CXSCREEN}) i .r0'
  System::Call 'user32::GetSystemMetrics(i ${SM_CYSCREEN}) i .r1'
  IntOp $2 $0 - ${SPLASH_W}
  IntOp $2 $2 / 2
  IntOp $3 $1 - ${SPLASH_H}
  IntOp $3 $3 / 2
  System::Call 'user32::SetWindowLong(i $R3, i ${GWL_STYLE}, i ${SPLASH_STYLE})'
  System::Call 'user32::SetWindowLong(i $R3, i ${GWL_EXSTYLE}, i ${SPLASH_EXSTYLE})'
  System::Call 'user32::SetWindowPos(i $R3, i ${HWND_TOPMOST}, i $2, i $3, \
    i ${SPLASH_W}, i ${SPLASH_H}, i ${SWP_FRAME_SHOW})'

  ; Rounded corners. CreateRoundRectRgn takes the bottom right corner as
  ; exclusive, hence the two extra pixels. The region is handed to the window
  ; and the system owns it from then on, so it must not be deleted here.
  IntOp $0 ${SPLASH_W} + 1
  IntOp $1 ${SPLASH_H} + 1
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i $0, i $1, \
    i ${CORNER}, i ${CORNER}) i .r2'
  System::Call 'user32::SetWindowRgn(i $R3, i $2, i 1)'

  done:
FunctionEnd

; Waits for the app to put its own window up before taking the splash away, so
; there is no bare desktop in between. The title is the one in
; renderer/index.html; build-launcher.js reads it from there and passes it in,
; so the two cannot drift apart. The class is Chromium's, which every Electron
; window shares, hence matching on the title as well.
;
; If the window never arrives the wait gives up rather than leaving a topmost
; window over whatever the user does next.
Function HideSplash
  StrCpy $R6 0
  wait:
    FindWindow $R7 "Chrome_WidgetWin_1" "${WINDOWTITLE}"
    IntCmp $R7 0 0 gone gone
    IntOp $R6 $R6 + 1
    IntCmp $R6 ${WAIT_TRIES} gone 0 gone
    Sleep ${WAIT_STEP}
    Goto wait
  gone:
  Banner::destroy
  IntCmp $R4 0 +2
  System::Call 'gdi32::DeleteObject(i $R4)'
FunctionEnd

; Every runtime-* beside this one. Left behind they are half a gigabyte each.
Function RemoveOldRuntimes
  FindFirst $0 $1 "$R1\runtime-*"
  loop:
    StrCmp $1 "" done
    StrCmp $1 "runtime-${VERSION}" next
    RMDir /r "$R1\$1"
  next:
    FindNext $0 $1
    Goto loop
  done:
  FindClose $0
FunctionEnd
