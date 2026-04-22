@echo off
title INICIADOR MEGA EXECUTIVE
cd /d "%~dp0"

echo [SISTEMA] Verificando Servidores...

:: Inicia o Backend em uma janela minimizada (se não estiver rodando)
netstat -ano | findstr :8000 > nul
if %errorlevel% neq 0 (
    echo [MOTOR] Ligando o Cerebro do MEGA...
    start /min "" venv\Scripts\python main.py
) else (
    echo [MOTOR] Cerebro ja esta ativo.
)

:: Inicia o Frontend em uma janela minimizada (se não estiver rodando)
netstat -ano | findstr :5173 > nul
if %errorlevel% neq 0 (
    echo [HUD] Ligando a Interface...
    cd /d "..\frontend"
    start /min "" npm run dev
    cd /d "..\backend"
) else (
    echo [HUD] Interface ja esta ativa.
)

echo [SISTEMA] Aguardando inicializacao (5s)...
timeout /t 5 > nul

echo [JARVIS] Criando Janela Flutuante...
powershell -ExecutionPolicy Bypass -File launch_window.ps1

echo [STATUS] MEGA ONLINE E EM PRIMEIRO PLANO!
exit
