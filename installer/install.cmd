@echo off
title Photobooth Agent - Installation

echo.
echo ========================================
echo      PHOTOBOOTH AGENT - INSTALLATION
echo ========================================
echo.
echo Ce programme va installer le logiciel
echo de maintenance du photobooth.
echo.
echo Une autorisation administrateur va etre
echo demandee par Windows.
echo.

pause

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -Command ""irm https://raw.githubusercontent.com/nielsou/photobooth-agent/main/installer/install.ps1 | iex""' -Wait"

echo.
echo ========================================
echo          INSTALLATION TERMINEE
echo ========================================
echo.
pause