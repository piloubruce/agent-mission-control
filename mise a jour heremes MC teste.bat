@echo off
rem =====================================================================================
rem Fichier : mise a jour heremes MC teste.bat
rem Emplacement : D:\Piloubruce\Desktop\mise a jour heremes MC teste.bat
rem Description : Lance le script PowerShell de deploiement pour Hermes MC Dashboard Test
rem =====================================================================================

title Deploiement Hermes MC - Dashboard Test
color 0B

echo.
echo =====================================================================
echo   HERMES MISSION CONTROL - DEPLOIEMENT DASHBOARD TEST
echo =====================================================================
echo.
echo Source des fichiers : D:\Piloubruce\Desktop\hermes MC deployement\
echo Destination serveur : D:\Hermes MC teste\
echo.
echo Lancement du script de deploiement PowerShell...
echo Veuillez patienter pendant la compilation et la copie des fichiers.
echo.

rem -ExecutionPolicy Bypass : Permet l'execution du script sans restriction de strategie Windows
rem -File : Lance deploiement_dashboard_MC_teste.ps1 situe dans le meme dossier (Desktop)
rem %~dp0 : Chemin complet du repertoire courant (D:\Piloubruce\Desktop\)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploiement_dashboard_MC_teste.ps1"

if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo.
    echo [ERREUR] Le deploiement a rencontre un probleme (Code erreur: %ERRORLEVEL%).
    echo.
    pause
) else (
    echo.
    echo [OK] Deploiement termine avec succes.
    echo.
)
