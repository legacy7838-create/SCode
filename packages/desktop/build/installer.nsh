!include nsDialogs.nsh
!include FileFunc.nsh

!ifndef ZCODE_INSTALLER_DEFAULT_LOG_PATH
  !define ZCODE_INSTALLER_DEFAULT_LOG_PATH "$TEMP\ZCode-installer.log"
!endif
!ifndef ZCODE_INSTALLER_ELEVATED_LOG_PATH
  !define ZCODE_INSTALLER_ELEVATED_LOG_PATH "$WINDIR\Logs\ZCode-installer.log"
!endif
!ifndef ZCODE_INSTALLER_IS_ELEVATED_INNER
  ; The inner instance is only simulated by test fixtures; in production the default is always false, so the elevated process keeps using the caller's /LOG.
  ; It uses the same UAC criterion as electron-builder; the isolation fixture can still override it explicitly without changing the real elevation flow.
  !include UAC.nsh
  !define ZCODE_INSTALLER_IS_ELEVATED_INNER `${UAC_IsInnerInstance}`
!endif

!ifndef ZCODE_INSTALL_MANIFEST_NAME
  !define ZCODE_INSTALL_MANIFEST_NAME ".zcode-install-manifest"
!endif

!ifndef ZCODE_UNINSTALLER_LOG_PATH
  !define ZCODE_UNINSTALLER_LOG_PATH "$TEMP\ZCode-uninstaller.log"
!endif
!ifndef ZCODE_UNINSTALLER_FUNCTION_PREFIX
  !define ZCODE_UNINSTALLER_FUNCTION_PREFIX "un."
!endif

!ifdef BUILD_UNINSTALLER
  Var ZCodeUninstallerLogUnavailable

  ; The uninstaller deletes old files only during updates; log the cleanup phase separately so the outer layer does not misreport permission/space errors as "app still running".
  !macro ZCodeReportUninstallerStage MESSAGE
    DetailPrint "ZCode: ${MESSAGE}"
    Push "${MESSAGE}"
    Call ${ZCODE_UNINSTALLER_FUNCTION_PREFIX}ZCodeWriteUninstallerLog
  !macroend

  Function ${ZCODE_UNINSTALLER_FUNCTION_PREFIX}ZCodeWriteUninstallerLog
    Exch $R9
    Push $R0
    Push $R1
    Push $R2

    StrCmp $ZCodeUninstallerLogUnavailable "1" zcodeUninstallerLogDone
    ClearErrors
    FileOpen $R1 "${ZCODE_UNINSTALLER_LOG_PATH}" a
    IfErrors zcodeUninstallerLogFailed zcodeUninstallerLogWrite
    zcodeUninstallerLogWrite:
      System::Call "kernel32::GetCurrentProcessId() i.R0"
      FileSeek $R1 0 END
      FileWrite $R1 "[pid=$R0] $R9$\r$\n"
      FileClose $R1
      Goto zcodeUninstallerLogDone
    zcodeUninstallerLogFailed:
      ; An unwritable log must not change the uninstall result; keep the original cleanup error for the outer layer to handle.
      StrCpy $ZCodeUninstallerLogUnavailable "1"
      ClearErrors
    zcodeUninstallerLogDone:
      Pop $R2
      Pop $R1
      Pop $R0
      Pop $R9
  FunctionEnd

  !macro customRemoveFilesDiagnosticsStart
    !insertmacro ZCodeReportUninstallerStage "cleanup-started"
  !macroend

  !macro customRemoveFilesDiagnosticsComplete
    !insertmacro ZCodeReportUninstallerStage "cleanup-completed"
  !macroend
!endif

!macro customRemoveFiles
  ; By default electron-builder recursively deletes the whole $INSTDIR on updates, wiping unrelated files the user put there.
  ; Delete only what the previous version's bundled ownership manifest lists; if the manifest is missing, migrating from an older version fails open and keeps files.
  ${if} ${isUpdated}
    !ifdef BUILD_UNINSTALLER
      !insertmacro customRemoveFilesDiagnosticsStart
    !endif
    ClearErrors
    FileOpen $R0 "$INSTDIR\${ZCODE_INSTALL_MANIFEST_NAME}" r
    IfErrors zcodeManifestMissing

    zcodeManifestRead:
      ClearErrors
      FileRead $R0 $R1
      IfErrors zcodeManifestClose
      ; NSIS FileRead keeps the trailing CRLF; the packaged manifest consistently uses newline endings, so strip the two trailing characters first.
      StrCpy $R1 $R1 -2
      StrCmp $R1 "" zcodeManifestRead

      ; Reject absolute paths and .. prefixes so a corrupted or tampered manifest cannot delete outside the install directory.
      StrCpy $R2 $R1 1
      StrCmp $R2 "\\" zcodeManifestRead
      StrCmp $R2 "/" zcodeManifestRead
      StrCpy $R2 $R1 2
      StrCmp $R2 ".." zcodeManifestRead
      StrCmp $R1 "${UNINSTALL_FILENAME}" zcodeManifestRead
      GetFullPathName $R2 "$INSTDIR\$R1"
      StrCmp $R2 "$INSTDIR\$R1" 0 zcodeManifestRead

      ; The current uninstaller and the outer installer are separate processes; log every item to the uninstaller log so it is possible to check which files were actually targeted for deletion.
      !ifdef BUILD_UNINSTALLER
        !insertmacro ZCodeReportUninstallerStage "cleanup-file path=$R1"
      !endif
      ClearErrors
      Delete "$INSTDIR\$R1"
      IfErrors zcodeManifestDeleteFailed
      Goto zcodeManifestRead

    zcodeManifestDeleteFailed:
      FileClose $R0
      !ifdef BUILD_UNINSTALLER
        !insertmacro ZCodeReportUninstallerStage "cleanup-failed reason=permission-or-disk-space"
      !endif
      Abort "Failed to delete old-version files: $INSTDIR\$R1"

    zcodeManifestClose:
      FileClose $R0
      Goto zcodeManifestDone

    zcodeManifestMissing:
      ; The first upgrade from an old version has no manifest; ownership must not be guessed and user files deleted.
      !ifdef BUILD_UNINSTALLER
        !insertmacro ZCodeReportUninstallerStage "cleanup-skipped reason=manifest-missing action=preserve"
      !endif
      ClearErrors

    zcodeManifestDone:
      !ifdef BUILD_UNINSTALLER
        !insertmacro customRemoveFilesDiagnosticsComplete
      !endif
  ${else}
    ; A normal uninstall keeps electron-builder's full-delete semantics; the ownership manifest only governs overwrite updates.
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${endIf}
!macroend

!ifndef BUILD_UNINSTALLER
  Var ZCodeInstallerLogPath
  Var ZCodeInstallerLogUnavailable
  Var ZCodeInstallerProcessRole
  Var ZCodeUninstallerDetailsUnavailable
  Var ZCodePreviousUninstallerSupportsManifest

  ; The details pane and the file log share the same stage event so silent installs do not lose key context.
  !macro ZCodeReportInstallerStage MESSAGE
    SetDetailsPrint listonly
    DetailPrint "ZCode: ${MESSAGE}"
    Push "${MESSAGE}"
    Call ZCodeWriteInstallerLog
  !macroend

  Function ZCodeWriteInstallerLog
    Exch $R9
    Push $R0
    Push $R1
    Push $R2

    StrCmp $ZCodeInstallerLogPath "" zcodeInstallerLogDone
    StrCmp $ZCodeInstallerLogUnavailable "1" zcodeInstallerLogDone
    StrCpy $R2 0
    zcodeInstallerLogOpen:
      ClearErrors
      FileOpen $R1 $ZCodeInstallerLogPath a
      IfErrors zcodeInstallerLogRetry zcodeInstallerLogWrite
    zcodeInstallerLogRetry:
      IntOp $R2 $R2 + 1
      IntCmp $R2 3 zcodeInstallerLogFailed zcodeInstallerLogWait zcodeInstallerLogFailed
    zcodeInstallerLogWait:
      Sleep 50
      Goto zcodeInstallerLogOpen
    zcodeInstallerLogWrite:
      System::Call "kernel32::GetCurrentProcessId() i.R0"
      FileSeek $R1 0 END
      FileWrite $R1 "[pid=$R0] $R9$\r$\n"
      FileClose $R1
      Goto zcodeInstallerLogDone
    zcodeInstallerLogFailed:
      StrCpy $ZCodeInstallerLogUnavailable "1"
      ClearErrors
    zcodeInstallerLogDone:
      Pop $R2
      Pop $R1
      Pop $R0
      Pop $R9
  FunctionEnd

  Function ZCodeResetUninstallerLog
    StrCpy $ZCodeUninstallerDetailsUnavailable ""
    ClearErrors
    FileOpen $R0 "${ZCODE_UNINSTALLER_LOG_PATH}" w
    IfErrors zcodeUninstallerDetailsResetFailed zcodeUninstallerDetailsResetSucceeded
    zcodeUninstallerDetailsResetSucceeded:
      FileClose $R0
      Goto zcodeUninstallerDetailsResetDone
    zcodeUninstallerDetailsResetFailed:
      ; Keep installing even when the outer details pane cannot read the old uninstaller log; the file log and the exit code remain authoritative.
      StrCpy $ZCodeUninstallerDetailsUnavailable "1"
      ClearErrors
    zcodeUninstallerDetailsResetDone:
  FunctionEnd

  Function ZCodeShowUninstallerCleanupDetails
    Push $R0
    Push $R1
    Push $R2

    StrCmp $ZCodeUninstallerDetailsUnavailable "1" zcodeShowUninstallerDetailsDone
    ClearErrors
    FileOpen $R0 "${ZCODE_UNINSTALLER_LOG_PATH}" r
    IfErrors zcodeShowUninstallerDetailsDone
    zcodeShowUninstallerDetailsRead:
      ClearErrors
      FileRead $R0 $R1
      IfErrors zcodeShowUninstallerDetailsClose
      StrCmp $R1 "" zcodeShowUninstallerDetailsRead
      SetDetailsPrint listonly
      DetailPrint "ZCode: cleanup-log $R1"
      Goto zcodeShowUninstallerDetailsRead
    zcodeShowUninstallerDetailsClose:
      FileClose $R0
    zcodeShowUninstallerDetailsDone:
      Pop $R2
      Pop $R1
      Pop $R0
  FunctionEnd

  !macro preInit
    Call ZCodeInitializeInstallerLog
  !macroend

  !macro customInit
    IfSilent zcodeInstallerInitSilent zcodeInstallerInitInteractive
    zcodeInstallerInitSilent:
      !insertmacro ZCodeReportInstallerStage "installer-initialized mode=silent"
      Goto zcodeInstallerInitDone
    zcodeInstallerInitInteractive:
      !insertmacro ZCodeReportInstallerStage "installer-initialized mode=interactive"
    zcodeInstallerInitDone:
  !macroend

  ; These macros are called in install order by the electron-builder installSection.nsh patch applied at packaging time.
  ; Only stage markers are written to the details and the log; the extracted-file listing comes from NSIS's File command in listonly mode.
  !macro customInstallSectionStarted
    !insertmacro ZCodeReportInstallerStage "install-started"
  !macroend

  !macro customInstallCleanupStarted
    Call ZCodeResetUninstallerLog
    !insertmacro ZCodeReportInstallerStage "cleanup-started"
  !macroend

  !macro customInstallCleanupCompleted
    !insertmacro ZCodeReportInstallerStage "cleanup-completed"
    Call ZCodeShowUninstallerCleanupDetails
  !macroend

  !macro customInstallExtractStarted
    !insertmacro ZCodeReportInstallerStage "extract-started"
  !macroend

  !macro customInstallExtractCompleted
    !insertmacro ZCodeReportInstallerStage "extract-completed"
  !macroend

  !macro customInstallShortcutsStarted
    !insertmacro ZCodeReportInstallerStage "shortcuts-started"
  !macroend

  !macro customInstallShortcutsCompleted
    !insertmacro ZCodeReportInstallerStage "shortcuts-completed"
  !macroend

  Function ZCodeDetectPreviousUninstallerCapabilities
    StrCpy $ZCodePreviousUninstallerSupportsManifest "0"
    ; The manifest is an uninstaller capability marker: its presence means the old uninstaller deletes selectively per the manifest.
    IfFileExists "$INSTDIR\${ZCODE_INSTALL_MANIFEST_NAME}" 0 zcodePreviousUninstallerCapabilityCheckNested
      StrCpy $ZCodePreviousUninstallerSupportsManifest "1"
      Return

    zcodePreviousUninstallerCapabilityCheckNested:
      ; The assisted installer's directory page only gains the APP_FILENAME subdirectory later, in instfilesPre; accommodate both shapes up front.
      IfFileExists "$INSTDIR\${APP_FILENAME}\${ZCODE_INSTALL_MANIFEST_NAME}" 0 zcodePreviousUninstallerCapabilityDone
        StrCpy $ZCodePreviousUninstallerSupportsManifest "1"

    zcodePreviousUninstallerCapabilityDone:
  FunctionEnd

  !macro customUnInstallCheck
    ; handleUninstallResult puts the old uninstaller's exit code in $R0; on failure show the cleanup diagnostics,
    ; do not fall back to appCannotBeClosed (that text only applies when a process is holding files).
    ${if} $R0 != 0
      ; Silent auto-updates are unattended: a modal box without /SD set waits forever for a click,
      ; so a clear exit code would never reach electron-updater. Use IDOK automatically when silent, still prompt when interactive.
      SetDetailsPrint listonly
      DetailPrint "ZCode: cleanup-failed exit-code=$R0"
      Call ZCodeShowUninstallerCleanupDetails
      MessageBox MB_OK|MB_ICONSTOP "Old-version cleanup failed (error code $R0). A file may be locked, permissions may be insufficient, or disk space may be low. Full log: ${ZCODE_UNINSTALLER_LOG_PATH}" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
  !macroend

  !macro customUnInstallCheckCurrentUser
    ; When a per-machine install switches to an older HKCU version, electron-builder takes a different hook;
    ; reuse the same diagnostics so the same cleanup failure does not fall back to the default text just because the registry root differs.
    !insertmacro customUnInstallCheck
  !macroend
!endif

!define ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH 180

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; The asynchronously generated header may include this file before the UAC plugin directory is registered.
    ; Expand the function in customHeader so the plugin is registered; preInit still calls the same function with the real UAC criterion.
    Function ZCodeInitializeInstallerLog
      Push $R0
      Push $R1
      Push $R2
      StrCpy $ZCodeInstallerLogUnavailable ""
      ${If} ${ZCODE_INSTALLER_IS_ELEVATED_INNER}
        StrCpy $ZCodeInstallerProcessRole "elevated-inner"
        StrCpy $ZCodeInstallerLogPath "${ZCODE_INSTALLER_ELEVATED_LOG_PATH}"
      ${Else}
        StrCpy $ZCodeInstallerProcessRole "outer"
        StrCpy $R0 $CMDLINE
        ClearErrors
        ${GetOptions} $R0 "/LOG=" $R1
        IfErrors zcodeInstallerLogUseDefault
        StrCmp $R1 "" zcodeInstallerLogUseDefault
        StrCpy $ZCodeInstallerLogPath $R1
        Goto zcodeInstallerLogPathReady
        zcodeInstallerLogUseDefault:
          StrCpy $ZCodeInstallerLogPath "${ZCODE_INSTALLER_DEFAULT_LOG_PATH}"
        zcodeInstallerLogPathReady:
          ${GetParent} $ZCodeInstallerLogPath $R2
          StrCmp $R2 "" zcodeInstallerLogInitialized
          CreateDirectory "$R2"
      ${EndIf}
      zcodeInstallerLogInitialized:
        !insertmacro ZCodeReportInstallerStage "installer-process-started role=$ZCodeInstallerProcessRole"
      Pop $R2
      Pop $R1
      Pop $R0
    FunctionEnd

    ; electron-builder's common.nsh sets ShowInstDetails nevershow first;
    ; with hide, this template combination can still leave a blank list with no way to expand it, so show the stage details permanently.
    ShowInstDetails show
    !ifdef allowToChangeInstallationDirectory
      ; electron-builder already used that switch in assistedInstaller.nsh to generate the install-directory page,
      ; but installUtil.nsh later also uses it to stop manual overwrites without --updated from keeping shortcuts, which makes the old uninstaller
      ; call UninstShortcut to unregister Start Menu pinned items. Remove the switch after the page is generated so auto-updates and manual overwrites
      ; that reinstall into the same directory both keep the same .lnk via KeepShortcuts.
      !undef allowToChangeInstallationDirectory
    !endif
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  ; electron-builder compiles the uninstaller first, but the shortcut-target read is only called in the update-install flow.
  ; If the function is pulled into the uninstaller, NSIS raises a 6010 unreferenced warning and aborts Windows CI under /WX.
  Function ZCodeReadShortcutTarget
    Exch $R9
    Push $R1
    Push $R2

    StrCpy $R2 ""
    System::Call 'Kernel32::SetEnvironmentVariableW(w "ZCODE_SHORTCUT_PATH", w "$R9") i.R1'
    StrCmp $R1 "0" zcodeReadShortcutTargetDone 0

    nsExec::ExecToStack /TIMEOUT=5000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "[Console]::Out.Write(([Activator]::CreateInstance([type]::GetTypeFromProgID('WScript.Shell'))).CreateShortcut([Environment]::GetEnvironmentVariable('ZCODE_SHORTCUT_PATH')).TargetPath)"`
    Pop $R1
    Pop $R2
    StrCmp $R1 "0" zcodeReadShortcutTargetDone 0
    StrCpy $R2 ""

    zcodeReadShortcutTargetDone:
      System::Call 'Kernel32::SetEnvironmentVariableW(w "ZCODE_SHORTCUT_PATH", p 0) i.R1'
      StrCpy $R9 "$R2"
      Pop $R2
      Pop $R1
      Exch $R9
  FunctionEnd
!endif

!macro ZCodeRepairShortcutIfNeeded SHORTCUT_PATH LABEL_PREFIX
  ${if} ${FileExists} "${SHORTCUT_PATH}"
    Push "${SHORTCUT_PATH}"
    Call ZCodeReadShortcutTarget
    Pop $R0
    StrCmp $R0 "$appExe" ${LABEL_PREFIX}Done 0

    ; Older versions may leave .lnk files pointing at a moved exe, but unconditionally overwriting correct shortcuts makes
    ; some Windows 11 installs lose the "All apps" index or the user\'s pin relationship, so only fix entries whose target mismatches.
    ClearErrors
    CreateShortCut "${SHORTCUT_PATH}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    IfErrors ${LABEL_PREFIX}Failed ${LABEL_PREFIX}Succeeded
    ${LABEL_PREFIX}Failed:
      DetailPrint "Unable to repair shortcut: ${SHORTCUT_PATH}"
      ClearErrors
      Goto ${LABEL_PREFIX}Done
    ${LABEL_PREFIX}Succeeded:
      WinShell::SetLnkAUMI "${SHORTCUT_PATH}" "${APP_ID}"
      ; The rewritten .lnk must notify the Shell after the last write so the Start Menu does not keep using the old index.
      System::Call 'Shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "${SHORTCUT_PATH}", p 0)'
    ${LABEL_PREFIX}Done:
  ${endIf}
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    !insertmacro ZCodeReportInstallerStage "install-finalization-started"
  !endif
  ${if} ${isUpdated}
  ${orIf} $keepShortcuts == "true"
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      !insertmacro ZCodeRepairShortcutIfNeeded "$newStartMenuLink" zcodeStartMenuShortcutRepair
    !endif

    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      !insertmacro ZCodeRepairShortcutIfNeeded "$newDesktopLink" zcodeDesktopShortcutRepair
    !endif
  ${endIf}

  ; Manual overwrites have no --updated, so inherited shortcuts still need a target check; a first install has no previous entries,
  ; so PowerShell must not be launched for nothing. Shortcuts the user deleted are not recreated either.
  ; The assisted installer's finish page always runs the exe this install wrote to disk.
  StrCpy $launchLink "$appExe"
  !ifndef BUILD_UNINSTALLER
    !insertmacro ZCodeReportInstallerStage "install-completed"
  !endif
!macroend

!macro customPageAfterChangeDir
  Function ZCodeResizeInstallDirBackButton
    GetDlgItem $1 $HWNDPARENT 3
    StrCmp $1 0 zcodeResizeInstallDirBackButtonDone 0

    System::Call "*(i 0, i 0, i 0, i 0) p.r2"
    StrCmp $2 0 zcodeResizeInstallDirBackButtonDone 0
    System::Call "user32::GetWindowRect(p r1, p r2)"
    System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r2, i 2)"
    System::Call "*$2(i.r3,i.r4,i.r5,i.r6)"
    System::Free $2

    IntOp $7 $5 - $3
    IntOp $8 $6 - $4
    IntCmp $7 ${ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH} zcodeResizeInstallDirBackButtonDone zcodeResizeInstallDirBackButtonResize zcodeResizeInstallDirBackButtonDone

    zcodeResizeInstallDirBackButtonResize:
      ; The blocking page relabels "Back" with a custom action label, and NSIS's default button width may clip the text.
      ; Widen it leftward while keeping the right edge fixed so it does not overlap the "Install/Cancel" buttons.
      IntOp $3 $5 - ${ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH}
      System::Call "user32::MoveWindow(p r1, i r3, i r4, i ${ZCODE_INSTALL_DIR_BACK_BUTTON_WIDTH}, i r8, i 1)"

    zcodeResizeInstallDirBackButtonDone:
  FunctionEnd

  Function ZCodeFindNestedDataDir
    Exch $R9
    Push $0
    Push $1

    StrCpy $R2 ""

    IfFileExists "$R9\.zcode\*.*" 0 +2
      StrCpy $R2 "$R9\.zcode"
    StrCmp $R2 "" 0 zcodeFindNestedDataDirDone
    IfFileExists "$R9\.zcode" 0 zcodeFindNestedDataDirListChildren
      StrCpy $R2 "$R9\.zcode"
    StrCmp $R2 "" 0 zcodeFindNestedDataDirDone

    zcodeFindNestedDataDirListChildren:
      FindFirst $0 $1 "$R9\*"
      IfErrors zcodeFindNestedDataDirDone

    zcodeFindNestedDataDirNext:
      StrCmp $1 "" zcodeFindNestedDataDirClose
      StrCmp $1 "." zcodeFindNestedDataDirContinue
      StrCmp $1 ".." zcodeFindNestedDataDirContinue
      IfFileExists "$R9\$1\*.*" 0 zcodeFindNestedDataDirContinue
        Push "$R9\$1"
        Call ZCodeFindNestedDataDir
        StrCmp $R2 "" zcodeFindNestedDataDirContinue zcodeFindNestedDataDirClose

    zcodeFindNestedDataDirContinue:
      FindNext $0 $1
      IfErrors zcodeFindNestedDataDirClose
      Goto zcodeFindNestedDataDirNext

    zcodeFindNestedDataDirClose:
      FindClose $0

    zcodeFindNestedDataDirDone:
      Pop $1
      Pop $0
      Pop $R9
  FunctionEnd

  Function ZCodeBlockInstallDirContainsData
    Call ZCodeDetectPreviousUninstallerCapabilities
    StrCmp $ZCodePreviousUninstallerSupportsManifest "1" zcodeInstallDirDataBlockSkip

    ; Users may put the data storage directory inside the install directory; Windows updates wipe .zcode when they replace the install directory.
    ; The assisted installer pads a chosen directory without the app name to "$INSTDIR\${APP_FILENAME}", so the final install directory is computed by the same rule here.
    ${StrContains} $R1 "${APP_FILENAME}" "$INSTDIR"
    StrCmp $R1 "" 0 zcodeInstallDirDataBlockUseSelectedDir
    StrCpy $R0 "$INSTDIR\${APP_FILENAME}"
    Goto zcodeInstallDirDataBlockCheckDir

    zcodeInstallDirDataBlockUseSelectedDir:
      StrCpy $R0 "$INSTDIR"

    zcodeInstallDirDataBlockCheckDir:
      ; The old guard only checked the .zcode directly under the final install directory, missing data under subdirectories such as data\.zcode.
      ; The installer manages the whole install-directory tree when overwriting, so any .zcode found recursively must block.
      Push "$R0"
      Call ZCodeFindNestedDataDir
      StrCmp $R2 "" zcodeInstallDirDataBlockSkip zcodeInstallDirDataBlockFound

    zcodeInstallDirDataBlockFound:
      IfSilent zcodeInstallDirDataBlockSilent

      !insertmacro MUI_HEADER_TEXT "Install directory must be changed" "The current install directory or one of its subdirectories contains a ZCode data directory"
      nsDialogs::Create 1018
      Pop $0
      StrCmp $0 error zcodeInstallDirDataBlockDialogFailed 0

      ${NSD_CreateLabel} 0u 0u 300u 44u "A .zcode data directory exists in this install directory or one of its subdirectories: $\r$\n$R2"
      Pop $1
      ${NSD_CreateLabel} 0u 54u 300u 70u "To keep past sessions and configuration from being cleared by the installer, go back and choose a different install directory.$\r$\n$\r$\nInstallation cannot continue in this directory."
      Pop $1

      GetDlgItem $1 $HWNDPARENT 1
      EnableWindow $1 0
      GetDlgItem $1 $HWNDPARENT 3
      EnableWindow $1 1
      SendMessage $1 ${WM_SETTEXT} 0 "STR:Choose another folder"
      Call ZCodeResizeInstallDirBackButton

      nsDialogs::Show
      Return

    zcodeInstallDirDataBlockDialogFailed:
      MessageBox MB_OK|MB_ICONSTOP "A .zcode data directory exists in this install directory or one of its subdirectories, so installation has stopped. Re-run the installer and choose a different install directory."
      SetErrorLevel 1
      Quit

    zcodeInstallDirDataBlockSilent:
      SetErrorLevel 1
      Quit

    zcodeInstallDirDataBlockSkip:
      Abort
  FunctionEnd

  Function ZCodeBlockInstallDirContainsDataLeave
    ; The blocking page's Next button is disabled, but automation or system hotkeys could still trigger the next page.
    ; The leave callback only handles the continue path, so it forces staying on this page, ensuring the user can only go back to change the install directory.
    Abort
  FunctionEnd

  Page custom ZCodeBlockInstallDirContainsData ZCodeBlockInstallDirContainsDataLeave
!macroend
