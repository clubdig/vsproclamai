@echo off
title VSProclamai - Instalador
color 0A

REM === Muda para o diretorio do proprio script ===
cd /d "%~dp0"

echo.
echo  ===================================================
echo     VSProclamai - Instalador Portatil
echo  ===================================================
echo.
echo  Diretorio: %cd%
echo.

echo  [1/5] Verificando Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  Node.js nao encontrado! Baixando...
    powershell -Command "iwr https://nodejs.org/dist/v20.15.1/node-v20.15.1-x64.msi -OutFile %TEMP%\node-install.msi"
    msiexec /i "%TEMP%\node-install.msi" /qn
    echo  Node.js instalado! Reinicie o terminal e execute instalar.bat novamente.
    pause
    exit /b
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo  Node.js %NODE_VER% encontrado!

echo.
echo  [2/5] Instalando dependencias...
echo  Isso pode levar alguns minutos na primeira vez...
echo.
call npm install --production
if %errorlevel% neq 0 (
    echo.
    echo  ERRO ao instalar dependencias!
    echo  Tente executar como Administrador.
    pause
    exit /b 1
)
echo  Dependencias instaladas!

echo.
echo  [3/5] Criando atalho na area de travailho...
set SCRIPT_DIR=%~dp0
set DESKTOP=%USERPROFILE%\Desktop

(
echo Set oWS = WScript.CreateObject^("WScript.Shell"^)
echo oWS.CurrentDirectory = "%SCRIPT_DIR%"
echo oWS.Run "cmd /c ""cd /d ""%SCRIPT_DIR%"" && node server.js""", 1, False
) > "%TEMP%\vsproclamai_shortcut.vbs"

(
echo Set oWS = WScript.CreateObject^("WScript.Shell"^)
echo Set oLink = oWS.CreateShortcut^("%DESKTOP%\VSProclamai.lnk"^)
echo oLink.TargetPath = "%TEMP%\vsproclamai_shortcut.vbs"
echo oLink.WorkingDirectory = "%SCRIPT_DIR%"
echo oLink.Description = "VSProclamai - Sistema de Performance ao Vivo"
echo oLink.WindowStyle = 7
echo oLink.Save
) > "%TEMP%\create_shortcut.vbs"

cscript //nologo "%TEMP%\create_shortcut.vbs"
del "%TEMP%\create_shortcut.vbs" >nul 2>&1
del "%TEMP%\vsproclamai_shortcut.vbs" >nul 2>&1
echo  Atalho criado na Area de Trabalho!

echo.
echo  [4/5] Criando script de inicializacao...
(
echo @echo off
echo title VSProclamai
echo cd /d "%%~dp0"
echo echo.
echo echo  VSProclamai iniciando em http://localhost:3000
echo echo  Pressione CTRL+C para parar.
echo echo.
echo node server.js
echo pause
) > "%SCRIPT_DIR%VSProclamai.bat"

echo  Script VSProclamai.bat criado!

echo.
echo  [5/5] Instalacao concluida!
echo.
echo  ===================================================
echo     INSTALACAO CONCLUIDA COM SUCESSO!
echo  ===================================================
echo.
echo  Para usar:
echo    - Clique duas vezes em "VSProclamai.bat"
echo    - Ou use o atalho na Area de Trabalho
echo    - Acesse: http://localhost:3000
echo.
echo  ===================================================
echo.
timeout /t 3 >nul
start http://localhost:3000
node server.js
