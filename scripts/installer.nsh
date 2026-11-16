; Pulled into electron-builder's installer by build.nsis.include in package.json.
;
; The installer registers .lwc itself, from build.win.fileAssociations. What it
; writes for the open command is the path to the app with no quotes round it,
; and the default install folder is "Program Files", which has a space in it.
; Windows guesses its way through a line like that, and guesses wrong the day a
; C:\Program.exe exists. This writes the same command again with the quotes.
;
; The class name has to match "name" in build.win.fileAssociations.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\LWClipper.Project\shell\open\command" "" '"$appExe" "%1"'
!macroend
