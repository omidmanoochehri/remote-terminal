; Remote Terminal agent — Windows installer.
;
; Produces RemoteTerminalAgentSetup-<version>.exe: one elevated installer that
; lays down the agent, registers the service, starts it and shows a pairing
; code, so the machine is reachable from the phone by the time the last page
; closes.
;
; Everything it installs is staged by build-installer.ps1 — the two Rust
; executables, the Node agent and its node_modules. The installer never runs
; npm and never touches the network: an installer that needs a working internet
; connection to finish is one that fails exactly where you most want it to work.
;
; Node.js is the one thing it does not carry — a 60 MB dependency the machine
; usually already has — so it checks for it up front and says what to do.

Unicode true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"
!include "WinMessages.nsh"
!include "x64.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef STAGE
  !define STAGE "stage"
!endif

!define APP_NAME     "Remote Terminal Agent"
!define SERVICE_NAME "RemoteTerminalAgent"
!define PUBLISHER    "Cactus Software Group"
!define SERVICE_EXE  "remote-terminal-service.exe"
!define TRAY_EXE     "remote-terminal-tray.exe"
!define SHELL_EXE    "remote-terminal-shell.exe"
!define REG_UNINST   "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
!define REG_RUN      "Software\Microsoft\Windows\CurrentVersion\Run"
!define REG_APP      "Software\${PUBLISHER}\${APP_NAME}"

Name "${APP_NAME} ${VERSION}"
OutFile "RemoteTerminalAgentSetup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
InstallDirRegKey HKLM "${REG_APP}" "InstallDir"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "CompanyName"     "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "LegalCopyright"  "(c) ${PUBLISHER}"

!define MUI_ABORTWARNING
!define MUI_ICON   "${STAGE}\icon.ico"
!define MUI_UNICON "${STAGE}\icon.ico"

Var RelayUrl
Var EnrollToken
Var MachineName
Var HwndRelay
Var HwndToken
Var HwndName
Var HwndTray
Var InstallTray
Var FinishText
Var DataDir

; ---------------------------------------------------------------- pages ----

!define MUI_WELCOMEPAGE_TITLE "Install the ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "This installs a Windows service that lets the Remote Terminal app open real terminals on this machine.$\r$\n$\r$\nThe service starts at boot, before anyone signs in, and keeps running after they sign out. Terminals it opens run as LocalSystem, so anyone who pairs a phone gets administrative access to this machine — the same trade an SSH server makes.$\r$\n$\r$\nHave your relay's URL and its enrolment token to hand."
!insertmacro MUI_PAGE_WELCOME

Page custom RelayPageCreate RelayPageLeave

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "The agent is running"
!define MUI_FINISHPAGE_TEXT "Setting up…"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow
!define MUI_FINISHPAGE_RUN "$INSTDIR\${TRAY_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Show the tray icon now"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ------------------------------------------------------------ relay page ----

Function RelayPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Your relay" "Where this machine connects, and the token that lets it enrol."

  ${NSD_CreateLabel} 0 0 100% 12u "Relay URL"
  Pop $0
  ${NSD_CreateText} 0 13u 100% 12u "$RelayUrl"
  Pop $HwndRelay

  ${NSD_CreateLabel} 0 31u 100% 12u "Enrolment token (the relay's ENROLL_TOKEN)"
  Pop $0
  ${NSD_CreatePassword} 0 44u 100% 12u "$EnrollToken"
  Pop $HwndToken

  ${NSD_CreateLabel} 0 62u 100% 12u "Name for this machine in the app"
  Pop $0
  ${NSD_CreateText} 0 75u 100% 12u "$MachineName"
  Pop $HwndName

  ${NSD_CreateCheckbox} 0 96u 100% 12u "Show a tray icon for everyone who signs in to this machine"
  Pop $HwndTray
  ${If} $InstallTray == 1
    ${NSD_Check} $HwndTray
  ${EndIf}

  ${NSD_CreateLabel} 0 114u 100% 26u "The token is kept in $DataDir, readable by SYSTEM and administrators only. Use wss:// anywhere but a trusted network."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function RelayPageLeave
  ${NSD_GetText} $HwndRelay $RelayUrl
  ${NSD_GetText} $HwndToken $EnrollToken
  ${NSD_GetText} $HwndName $MachineName
  ${NSD_GetState} $HwndTray $InstallTray

  ${If} $RelayUrl == ""
  ${OrIf} $RelayUrl == "wss://"
    MessageBox MB_ICONEXCLAMATION "Enter the relay URL, for example wss://relay.example.com."
    Abort
  ${EndIf}
  ${If} $EnrollToken == ""
    MessageBox MB_ICONEXCLAMATION "Enter the relay's enrolment token — the ENROLL_TOKEN the relay was started with."
    Abort
  ${EndIf}
FunctionEnd

; The finish page's text is only known once the service has answered, so it is
; written into the label at show time rather than defined at compile time.
Function FinishShow
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 1006
  SendMessage $1 ${WM_SETTEXT} 0 "STR:$FinishText"
FunctionEnd

; ------------------------------------------------------------------ init ----

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This agent needs 64-bit Windows."
    Abort
  ${EndIf}
  SetRegView 64

  ReadEnvStr $MachineName "COMPUTERNAME"
  ReadEnvStr $DataDir "ProgramData"
  ${If} $DataDir == ""
    StrCpy $DataDir "C:\ProgramData"
  ${EndIf}
  StrCpy $DataDir "$DataDir\RemoteTerminal"
  StrCpy $RelayUrl "wss://"
  StrCpy $InstallTray 1

  ; Node.js is not bundled. Fail here, with the reason, rather than half way
  ; through an install that could not possibly work.
  ;
  ; `node --version` and not `node -p "…"`: cmd.exe strips the inner quotes out
  ; of a nested expression, so the fancier check failed on every machine and
  ; aborted the installer before its first page.
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /c node --version'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Node.js was not found on this machine.$\r$\n$\r$\nInstall Node.js 18 or newer from https://nodejs.org, then run this installer again."
    Abort
  ${EndIf}
  ${TrimNewLines} $1 $1

  ; "v24.15.0" -> 24. Drop the v, then keep digits up to the first dot.
  StrCpy $2 $1 1
  ${If} $2 == "v"
    StrCpy $1 $1 "" 1
  ${EndIf}
  StrCpy $3 ""
  StrCpy $4 0
  major_loop:
    StrCpy $2 $1 1 $4
    ${If} $2 == ""
    ${OrIf} $2 == "."
      Goto major_done
    ${EndIf}
    StrCpy $3 "$3$2"
    IntOp $4 $4 + 1
    Goto major_loop
  major_done:

  ${If} $3 == ""
    MessageBox MB_ICONSTOP|MB_OK "Node.js reported a version this installer could not read ($1).$\r$\n$\r$\nInstall Node.js 18 or newer from https://nodejs.org."
    Abort
  ${EndIf}
  ${If} $3 < 18
    MessageBox MB_ICONSTOP|MB_OK "Node.js $3 is too old; the agent needs 18 or newer.$\r$\n$\r$\nUpdate it from https://nodejs.org and run this installer again."
    Abort
  ${EndIf}
FunctionEnd

Function un.onInit
  SetRegView 64
  ReadEnvStr $DataDir "ProgramData"
  ${If} $DataDir == ""
    StrCpy $DataDir "C:\ProgramData"
  ${EndIf}
  StrCpy $DataDir "$DataDir\RemoteTerminal"
FunctionEnd

; --------------------------------------------------------------- install ----

Section "Agent" SecAgent
  SectionIn RO
  SetRegView 64

  ; A previous version may be running: the service holds one executable open
  ; and the tray holds the other.
  DetailPrint "Stopping any running agent..."
  nsExec::ExecToLog '"$INSTDIR\${SERVICE_EXE}" stop'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM ${TRAY_EXE}'
  Pop $0
  ; 0.8 and earlier ran the agent from a per-user logon task instead.
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN "${SERVICE_NAME}" /F'
  Pop $0

  SetOutPath "$INSTDIR"
  SetOverwrite on
  File "${STAGE}\${SERVICE_EXE}"
  File "${STAGE}\${TRAY_EXE}"
  File "${STAGE}\${SHELL_EXE}"
  File "${STAGE}\index.js"
  File "${STAGE}\package.json"
  File "${STAGE}\config.example.json"
  File /nonfatal "${STAGE}\package-lock.json"
  File /r "${STAGE}\lib"
  File /r "${STAGE}\node_modules"

  WriteRegStr HKLM "${REG_APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${REG_APP}" "Version" "${VERSION}"

  DetailPrint "Registering the ${SERVICE_NAME} service..."
  nsExec::ExecToLog '"$INSTDIR\${SERVICE_EXE}" install --agent "$INSTDIR\index.js" --data "$DataDir" --server "$RelayUrl" --enroll-token "$EnrollToken" --name "$MachineName"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "The service installer returned $0."
    StrCpy $FinishText "The files are installed, but the agent did not reach the relay.$\r$\n$\r$\nCheck $DataDir\logs\agent.log, then run:$\r$\n    $INSTDIR\${SERVICE_EXE} status"
  ${Else}
    Call ReadPairCode
  ${EndIf}

  ${If} $InstallTray == 1
    WriteRegStr HKLM "${REG_RUN}" "RemoteTerminalTray" '"$INSTDIR\${TRAY_EXE}"'
  ${Else}
    DeleteRegValue HKLM "${REG_RUN}" "RemoteTerminalTray"
  ${EndIf}

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Remote Terminal Agent (tray).lnk" "$INSTDIR\${TRAY_EXE}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Pair a phone.lnk" "$INSTDIR\${TRAY_EXE}" "--pair"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegStr   HKLM "${REG_UNINST}" "DisplayName"          "${APP_NAME}"
  WriteRegStr   HKLM "${REG_UNINST}" "DisplayVersion"       "${VERSION}"
  WriteRegStr   HKLM "${REG_UNINST}" "Publisher"            "${PUBLISHER}"
  WriteRegStr   HKLM "${REG_UNINST}" "DisplayIcon"          "$INSTDIR\${TRAY_EXE}"
  WriteRegStr   HKLM "${REG_UNINST}" "InstallLocation"      "$INSTDIR"
  WriteRegStr   HKLM "${REG_UNINST}" "UninstallString"      '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKLM "${REG_UNINST}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${REG_UNINST}" "EstimatedSize"        "$0"
  WriteRegDWORD HKLM "${REG_UNINST}" "NoModify" 1
  WriteRegDWORD HKLM "${REG_UNINST}" "NoRepair" 1
SectionEnd

; A code on the last page is the difference between "installed" and "ready to
; use". `pair --code-only` prints nothing else, so this cannot be broken by a
; wording change somewhere in the status output.
Function ReadPairCode
  nsExec::ExecToStack '"$INSTDIR\${SERVICE_EXE}" pair --code-only'
  Pop $0
  Pop $1
  ${TrimNewLines} $1 $1
  ${If} $0 == 0
  ${AndIf} $1 != ""
    StrCpy $FinishText "Pairing code:  $1$\r$\n$\r$\nIn the app: Machines -> Pair -> enter your relay URL and this code. It works once, within five minutes.$\r$\n$\r$\nFor another code later, use the tray icon or run:$\r$\n    $INSTDIR\${SERVICE_EXE} pair"
  ${Else}
    StrCpy $FinishText "The service is installed and running.$\r$\n$\r$\nFor a pairing code, use the tray icon's $\"Pair a phone$\", or run this from an elevated prompt:$\r$\n    $INSTDIR\${SERVICE_EXE} pair"
  ${EndIf}
FunctionEnd

; ------------------------------------------------------------- uninstall ----

Section "Uninstall"
  SetRegView 64

  DetailPrint "Stopping and removing the service..."
  nsExec::ExecToLog '"$INSTDIR\${SERVICE_EXE}" uninstall'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM ${TRAY_EXE}'
  Pop $0

  DeleteRegValue HKLM "${REG_RUN}" "RemoteTerminalTray"
  DeleteRegKey HKLM "${REG_UNINST}"
  DeleteRegKey HKLM "${REG_APP}"

  Delete "$SMPROGRAMS\${APP_NAME}\*.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  RMDir /r "$INSTDIR\lib"
  RMDir /r "$INSTDIR\node_modules"
  Delete "$INSTDIR\${SERVICE_EXE}"
  Delete "$INSTDIR\${TRAY_EXE}"
  Delete "$INSTDIR\${SHELL_EXE}"
  Delete "$INSTDIR\index.js"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\config.example.json"
  Delete "$INSTDIR\service.conf"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; The identity and the relay URL are kept by default: reinstalling should not
  ; mean pairing every phone again. Ask only when there is something to lose,
  ; and never during a silent uninstall.
  IfSilent done
  IfFileExists "$DataDir\state.json" 0 done
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete this machine's identity, configuration and logs?$\r$\n$\r$\nKeep them if you plan to reinstall — the phones you have paired will keep working. Delete them if you are finished with this machine.$\r$\n$\r$\n($DataDir)" IDNO done
      RMDir /r "$DataDir"
      MessageBox MB_ICONINFORMATION|MB_OK "Removed. Remove this machine in the app as well, so the relay revokes its token."
  done:
SectionEnd
