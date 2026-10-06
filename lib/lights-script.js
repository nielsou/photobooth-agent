// dslrBooth "trigger application" that drives the Smart Flash lights through
// the Arduino. dslrBooth calls it at each step of a session with the event
// name (%1) and, during the countdown, its progress in percent (%2, about ten
// times a second). The agent writes it on each booth with the board's COM
// port (PORTNUMBER) and SMART_FLASH_ACTIVATED (FALSE, set in the dashboard,
// for lights that must stay on, e.g. on a generator). Plain ASCII and CRLF:
// cmd.exe reads .bat files in the OEM code page.
const LINES = String.raw`@echo off
rem Smart Flash lights, called by dslrBooth at each step of a session:
rem %1 = event, %2 = countdown progress (0 to 100).
rem Written by the Photobooth agent: PORTNUMBER and SMART_FLASH_ACTIVATED are
rem set per booth (dashboard), do not edit them here.

set PORTNUMBER=COM6
set MIN_BRIGHTNESS=9
set MAX_BRIGHTNESS=80
rem FALSE: no modulation, always FIXED_BRIGHTNESS (lights on a generator)
set SMART_FLASH_ACTIVATED=TRUE
set FIXED_BRIGHTNESS=100
rem set LOGFILE=C:\dslrbooth\status.txt

rem DTR=OFF: opening the port does not reset the Arduino
mode %PORTNUMBER% BAUD=115200 PARITY=N DATA=8 STOP=1 DTR=OFF >nul

set PROGRESS=%2
if not defined PROGRESS set PROGRESS=0
set BRIGHTNESS=%MIN_BRIGHTNESS%

if /i "%SMART_FLASH_ACTIVATED%"=="FALSE" (
    set BRIGHTNESS=%FIXED_BRIGHTNESS%
) else if "%1"=="countdown" (
    rem From MIN to MAX as the countdown goes
    set /a "BRIGHTNESS=MIN_BRIGHTNESS + PROGRESS * (MAX_BRIGHTNESS - MIN_BRIGHTNESS) / 100"
) else if "%1"=="capture_start" (
    set BRIGHTNESS=%MAX_BRIGHTNESS%
) else if "%1"=="file_download" (
    set BRIGHTNESS=%MIN_BRIGHTNESS%
) else if "%1"=="session_end" (
    set BRIGHTNESS=%MIN_BRIGHTNESS%
)

echo set_brightness %BRIGHTNESS% > %PORTNUMBER%
rem echo %1 %2 set_brightness %BRIGHTNESS% >> %LOGFILE%
`.split(/\r?\n/);

export const LIGHTS_SCRIPT_CONTENT = LINES.join("\r\n");
