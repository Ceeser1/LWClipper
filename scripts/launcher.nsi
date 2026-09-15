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
; Built by scripts/build-launcher.js, which supplies every define below.

Unicode true
!include "FileFunc.nsh"

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

Name "LWClipper"
OutFile "${OUTFILE}"
!ifdef ICON
  Icon "${ICON}"
!endif

; No elevation: everything it writes is under the user's own profile.
RequestExecutionLevel user
; Measured: with this on, every launch spends about 8 seconds CRC-checking the
; whole 146MB archive before it does anything, which swamped the saving from
; caching the runtime and made the cached path slower than extracting. The stub
; is read off local disk and a corrupt one fails at extraction anyway.
; electron-builder's own portable template turns it off for the same reason.
CRCCheck off
WindowIcon Off
AutoCloseWindow True
; No installer window of any kind: the splash below is the only thing shown.
SilentInstall silent
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

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "LWClipper"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Lightweight clipper for local files and video links"
VIAddVersionKey "CompanyName" "Ceeser"
VIAddVersionKey "LegalCopyright" ""

; Win32 names, so the System::Call lines below read as something other than
; a wall of hex.
!define GWL_STYLE        -16
!define GWL_EXSTYLE      -20
!define SPLASH_STYLE     0x90000000 ; WS_POPUP | WS_VISIBLE
; Topmost and nothing else. What a dialog carries otherwise is WS_EX_WINDOWEDGE
; and WS_EX_DLGMODALFRAME, which draw a raised white edge down the right and
; along the bottom of a window that is meant to be a plain picture.
!define SPLASH_EXSTYLE   0x00000008 ; WS_EX_TOPMOST
!define PICTURE_STYLE    0x5000000E ; WS_CHILD | WS_VISIBLE | SS_BITMAP
!define SWP_FRAME_SHOW   0x00000060 ; SWP_FRAMECHANGED | SWP_SHOWWINDOW
!define SWP_FRAME_KEEPZ  0x00000024 ; SWP_FRAMECHANGED | SWP_NOZORDER
!define HWND_TOPMOST     -1
!define LR_LOADFROMFILE  0x00000010
!define STM_SETIMAGE     0x00000172
!define IMAGE_BITMAP     0
!define IDC_STR          1030       ; the one control on Banner's dialog
!define SM_CXSCREEN      0
!define SM_CYSCREEN      1
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

; $R1 the app's folder, $R2 this version's runtime inside it.
; $R3 the splash window, $R4 its bitmap, $R5 the control drawing it.
Section
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
SectionEnd

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
