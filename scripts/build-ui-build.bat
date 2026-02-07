@echo off
setlocal

set SCRIPT_DIR=%~dp0
for %%I in ("%SCRIPT_DIR%..") do set ROOT_DIR=%%~fI

if not defined PYTHON (
  set PYTHON=python
)

%PYTHON% -m pip install --upgrade pip
%PYTHON% -m pip install --upgrade pyinstaller

%PYTHON% -m PyInstaller --noconsole --onefile --name build-ui "%SCRIPT_DIR%build-ui.py" --distpath "%ROOT_DIR%\dist" --workpath "%ROOT_DIR%\build-ui-build" --specpath "%ROOT_DIR%\build-ui-spec"

echo.
echo Build UI exe is at %ROOT_DIR%\dist\build-ui.exe
endlocal
