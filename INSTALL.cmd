@echo off
setlocal
set "INSTALLER_ROOT=%~dp0"
if not exist "%INSTALLER_ROOT%scripts\install-wizard.ps1" (
  echo Installer files are missing. Extract the entire ZIP before running INSTALL.cmd.
  pause
  exit /b 2
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER_ROOT%scripts\install-wizard.ps1"
set "INSTALL_EXIT=%ERRORLEVEL%"
echo.
if not "%INSTALL_EXIT%"=="0" echo Installation failed with exit code %INSTALL_EXIT%.
if "%INSTALL_EXIT%"=="0" echo Installation completed successfully.
pause
exit /b %INSTALL_EXIT%
