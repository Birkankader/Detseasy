; Installers up to v0.1.6 were built on macOS without an app icon. There,
; electron-builder writes the uninstaller itself (UninstallerReader) without
; patching in the uninstaller icon, so when the installer and uninstaller icons
; differ the uninstaller's CRC no longer matches: run by hand it shows
; "NSIS Error", run during an update it exits with code 2 and the update stops
; with "Failed to uninstall old application files". The app is closed by then
; (CHECK_APP_RUNNING), so install over the old files instead of giving up.
!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint "Old uninstaller failed (code $R0); installing over the existing files."
  ${endIf}
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend
