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

rem Configure COM port
mode %PORTNUMBER% BAUD=115200 PARITY=N DATA=8 STOP=1 >nul

set PROGRESS=%2
if not defined PROGRESS set PROGRESS=0
rem Integer part only (set /a fails on "45.5" or "45,5")
for /f "tokens=1 delims=.," %%a in ("%PROGRESS%") do set PROGRESS=%%a
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

// The original script (Drive "Event logger/DSLR_Tiggers.bat", SHA-256
// FA6B38E9...DA03), byte for byte, with only the countdown line fixed: it used
// %2 * MAX / 100, so the lights dropped close to 0 during the countdown
// instead of rising from MIN to MAX (%2 = countdown progress in percent).
// Everything that talks to the card (mode, echo) is untouched: the rewritten
// script above broke the lights with DTR=OFF.
const ORIGINAL_BASE64 = "QGVjaG8gb2ZmDQoNCjo6IEdsb2JhbCB2YXJpYWJsZXMNCnNldCBQT1JUTlVNQkVSPUNPTTYNCnNldCBNSU5fQlJJR0hUTkVTUz05DQpzZXQgTUFYX0JSSUdIVE5FU1M9ODANCjo6c2V0IExPR0ZJTEU9QzpcZHNscmJvb3RoXHN0YXR1cy50eHQNCg0KOjogQ29uZmlndXJlIENPTSBwb3J0DQptb2RlICVQT1JUTlVNQkVSJSBCQVVEPTExNTIwMCBQQVJJVFk9TiBEQVRBPTggU1RPUD0xDQoNCjo6IEluaXRpYWxpc2F0aW9uIGRlIGxhIHZhcmlhYmxlIEJSSUdIVE5FU1MNCnNldCBCUklHSFRORVNTPSVNSU5fQlJJR0hUTkVTUyUNCg0KOjogVsOpcmlmaWNhdGlvbiBkZSBsYSBjb25kaXRpb24NCmlmICIlMSI9PSJjb3VudGRvd24iICgNCiAgICA6OiBDYWxjdWwgZGUgbGEgbHVtaW5vc2l0w6kgcHJvcG9ydGlvbm5lbGxlIChlbnRpZXIgc2V1bGVtZW50KQ0KICAgIHNldCAvYSBCUklHSFRORVNTPSUyKiVNQVhfQlJJR0hUTkVTUyUvMTAwDQopIGVsc2UgaWYgIiUxIj09ImNhcHR1cmVfc3RhcnQiICgNCiAgICBzZXQgQlJJR0hUTkVTUz0lTUFYX0JSSUdIVE5FU1MlDQopIGVsc2UgaWYgIiUxIj09ImZpbGVfZG93bmxvYWQiICgNCiAgICBzZXQgQlJJR0hUTkVTUz0lTUlOX0JSSUdIVE5FU1MlDQopIGVsc2UgaWYgIiUxIj09InNlc3Npb25fZW5kIiAoDQogICAgc2V0IEJSSUdIVE5FU1M9JU1JTl9CUklHSFRORVNTJQ0KKQ0KDQo6OiBFbnZvaSBkZSBsYSBjb21tYW5kZSBkZSBsdW1pbm9zaXTDqSBhdSBwb3J0IENPTQ0KZWNobyBzZXRfYnJpZ2h0bmVzcyAlQlJJR0hUTkVTUyUgPiAlUE9SVE5VTUJFUiUNCjo6ZWNobyAlMSBzZXRfYnJpZ2h0bmVzcyAlQlJJR0hUTkVTUyUgPj4gJUxPR0ZJTEUlDQo=";
const ORIGINAL_COUNTDOWN = "    set /a BRIGHTNESS=%2*%MAX_BRIGHTNESS%/100";
const FIXED_COUNTDOWN = '    set /a "BRIGHTNESS=MIN_BRIGHTNESS + %2 * (MAX_BRIGHTNESS - MIN_BRIGHTNESS) / 100"';

const original = Buffer.from(ORIGINAL_BASE64, "base64").toString("utf8");
if (!original.includes(ORIGINAL_COUNTDOWN)) throw new Error("lights script: countdown line not found");

export const LIGHTS_SCRIPT_ORIGINAL_FIXED = original.replace(ORIGINAL_COUNTDOWN, () => FIXED_COUNTDOWN);
