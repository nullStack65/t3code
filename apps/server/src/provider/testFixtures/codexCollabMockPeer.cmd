@echo off
rem Synthetic Codex protocol peer, including its no-model version probe.
if "%1"=="--version" (
  echo codex-cli 0.162.1
  exit /b 0
)
shift /1
node "%~dp0codexCollabMockPeer.mjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
