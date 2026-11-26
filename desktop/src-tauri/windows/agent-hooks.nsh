; Rulith Brain Agent's installer hooks (Tauri's NSIS template calls them).
;
; The install folder holds the shell and the agent it starts (agent\node\node.exe, agent\app). The shell's own data -
; the window's storage and a short log - is in %LOCALAPPDATA%\Rulith\BrainAgent; the agent's own files (its dsh
; profile, the page's transcripts) are in %USERPROFILE%\.rulith-brain-agent, where the zip package keeps them too.
; The memory is Rulith Brain's: nothing of it is here.

!macro RULITH_AGENT_STOP
  ; an agent this install started (Node under $INSTDIR, and what it started) holds files the setup replaces or
  ; removes. Only processes whose file lies under $INSTDIR (read from Win32_Process: the setup is 32-bit, and
  ; Get-Process there cannot read a 64-bit process's path)
  nsExec::Exec `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'node.exe' -and $$_.ExecutablePath -like '$INSTDIR\*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro RULITH_AGENT_STOP
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro RULITH_AGENT_STOP
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; "Delete the application data": the window's storage and the log go. The agent's own files
    ; (%USERPROFILE%\.rulith-brain-agent: its profile and the page's transcripts) stay - they are the user's, and the
    ; zip package uses the same folder
    ${If} $DeleteAppDataCheckboxState = 1
      RMDir /r "$LOCALAPPDATA\Rulith\BrainAgent\webview"
      RMDir /r "$LOCALAPPDATA\Rulith\BrainAgent\logs"
      RMDir "$LOCALAPPDATA\Rulith\BrainAgent"
    ${EndIf}
  ${EndIf}
!macroend
