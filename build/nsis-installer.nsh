;Inspired by:
; https://gist.github.com/bogdibota/062919938e1ed388b3db5ea31f52955c
; https://stackoverflow.com/questions/34177547/detect-if-visual-c-redistributable-for-visual-studio-2013-is-installed
; https://stackoverflow.com/a/54391388
; https://github.com/GitCommons/cpp-redist-nsis/blob/main/installer.nsh

;Find latests downloads here:
; https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist

!include LogicLib.nsh
!include x64.nsh

; https://github.com/electron-userland/electron-builder/issues/1122
!ifndef BUILD_UNINSTALLER
  ; Best-effort: ensure the app is not running before upgrade/uninstall.
  ; This reduces "Failed to uninstall old application files" caused by background/tray instances.
  Function killProcessByName
    Exch $R0
    Push $R1

    ; Ensure .exe suffix
    StrCpy $R1 $R0 4 -4
    ${If} $R1 != ".exe"
      StrCpy $R0 "$R0.exe"
    ${EndIf}

    ; Try graceful termination first, then force kill. Ignore errors/output.
    nsExec::Exec '"$SYSDIR\\taskkill.exe" /IM "$R0" /T >NUL 2>&1'
    Sleep 800
    nsExec::Exec '"$SYSDIR\\taskkill.exe" /F /IM "$R0" /T >NUL 2>&1'
    Sleep 800

    Pop $R1
    Pop $R0
  FunctionEnd

  Function ensureAppNotRunning
    Push $R0
    Push $R1

    ; Current build executable (usually equals ${PRODUCT_FILENAME}.exe).
    Push "${PRODUCT_FILENAME}"
    Call killProcessByName

    Pop $R1
    Pop $R0
  FunctionEnd

  Function checkVCRedist
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  FunctionEnd

  Function checkArchitectureCompatibility
    ; Initialize variables
    StrCpy $0 "0"  ; Default to incompatible
    StrCpy $1 ""   ; System architecture
    StrCpy $3 ""   ; App architecture

    ; Check system architecture using built-in NSIS functions
    ${If} ${RunningX64}
      ; Check if it's ARM64 by looking at processor architecture
      ReadEnvStr $2 "PROCESSOR_ARCHITECTURE"
      ReadEnvStr $4 "PROCESSOR_ARCHITEW6432"

      ${If} $2 == "ARM64"
      ${OrIf} $4 == "ARM64"
        StrCpy $1 "arm64"
      ${Else}
        StrCpy $1 "x64"
      ${EndIf}
    ${Else}
      StrCpy $1 "x86"
    ${EndIf}

    ; Determine app architecture based on build variables
    !ifdef APP_ARM64_NAME
      !ifndef APP_64_NAME
        StrCpy $3 "arm64"  ; App is ARM64 only
      !endif
    !endif
    !ifdef APP_64_NAME
      !ifndef APP_ARM64_NAME
        StrCpy $3 "x64"    ; App is x64 only
      !endif
    !endif
    !ifdef APP_64_NAME
      !ifdef APP_ARM64_NAME
        StrCpy $3 "universal"  ; Both architectures available
      !endif
    !endif

    ; If no architecture variables are defined, assume x64
    ${If} $3 == ""
      StrCpy $3 "x64"
    ${EndIf}

    ; Compare system and app architectures
    ${If} $3 == "universal"
      ; Universal build, compatible with all architectures
      StrCpy $0 "1"
    ${ElseIf} $1 == $3
      ; Architectures match
      StrCpy $0 "1"
    ${Else}
      ; Architectures don't match
      StrCpy $0 "0"
    ${EndIf}
  FunctionEnd
!endif

!macro customInit
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4

  ; Best-effort close/kill running instances to allow in-place upgrade.
  Call ensureAppNotRunning

  ; Check architecture compatibility first
  Call checkArchitectureCompatibility
  ${If} $0 != "1"
    MessageBox MB_ICONEXCLAMATION "\
      Architecture Mismatch$\r$\n$\r$\n\
      This installer is not compatible with your system architecture.$\r$\n\
      Your system: $1$\r$\n\
      App architecture: $3$\r$\n$\r$\n\
      Please download the correct version from:$\r$\n\
      https://github.com/motto1/Read-No-More/releases"
    ExecShell "open" "https://github.com/motto1/Read-No-More/releases"
    Abort
  ${EndIf}

  Call checkVCRedist
  ${If} $0 != "1"
    MessageBox MB_YESNO "\
      NOTE: ${PRODUCT_NAME} requires $\r$\n\
      'Microsoft Visual C++ Redistributable'$\r$\n\
      to function properly.$\r$\n$\r$\n\
      Download and install now?" /SD IDYES IDYES InstallVCRedist IDNO DontInstall
    InstallVCRedist:
      inetc::get /CAPTION " " /BANNER "Downloading Microsoft Visual C++ Redistributable..." "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe"
      ExecWait "$TEMP\vc_redist.x64.exe /install /norestart"
      ;IfErrors InstallError ContinueInstall ; vc_redist exit code is unreliable :(
      Call checkVCRedist
      ${If} $0 == "1"
        Goto ContinueInstall
      ${EndIf}

    ;InstallError:
      MessageBox MB_ICONSTOP "\
        There was an unexpected error installing$\r$\n\
        Microsoft Visual C++ Redistributable.$\r$\n\
        The installation of ${PRODUCT_NAME} cannot continue."
    DontInstall:
      Abort
  ${EndIf}
  ContinueInstall:
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
!macroend
