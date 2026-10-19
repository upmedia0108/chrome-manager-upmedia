@echo off
chcp 65001 >nul
title Cai dat lan dau - Chrome Manager by UP Media
cd /d "%~dp0"

REM ====== SUA 2 DONG NAY NEU CAN ======
set REPO_URL=https://github.com/tuyenthanh829/chrome-manager-upmedia.git
set GIT_NAME=Tuyen Thanh
set GIT_EMAIL=tuyennt@upmedia.vn
REM ====================================

echo ============================================================
echo   CAI DAT LAN DAU - Day du an len GitHub
echo ============================================================
echo.
echo Truoc khi chay: hay tao 1 repo RONG tren GitHub (xem HUONG-DAN-GITHUB.txt)
echo Repo se day len: %REPO_URL%
echo.
pause

REM Tu tim Git neu no chua nam trong PATH (vd da cai Git for Windows nhung chua them vao PATH)
where git >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
where git >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "PATH=%ProgramFiles(x86)%\Git\cmd;%PATH%"
where git >nul 2>nul
if errorlevel 1 if exist "%LocalAppData%\Programs\Git\cmd\git.exe" set "PATH=%LocalAppData%\Programs\Git\cmd;%PATH%"
where git >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay Git tren may ^(hoac Git chua duoc them vao PATH^).
  echo Hay tai va cai Git tai: https://git-scm.com/download/win
  echo Khi cai, giu nguyen tuy chon mac dinh "Git from the command line..." roi mo lai file nay.
  echo.
  pause
  exit /b 1
)

git config --global user.name "%GIT_NAME%"
git config --global user.email "%GIT_EMAIL%"

if not exist ".git" (
  echo Dang khoi tao Git...
  git init
  git branch -M main
)

git remote remove origin >nul 2>nul
git remote add origin %REPO_URL%

echo Dang luu toan bo du an...
git add -A
git commit -m "Khoi tao repo rieng - Chrome Manager by UP Media v1.9.0"

echo.
echo Dang day len GitHub (lan dau se hien cua so dang nhap GitHub)...
git push -u origin main
if errorlevel 1 (
  echo.
  echo [LOI] Day len that bai. Kiem tra:
  echo   1. Da tao repo RONG tren GitHub dung ten "chrome-manager-upmedia" chua?
  echo   2. Da dang nhap GitHub khi cua so hien ra chua?
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   XONG! Tu lan sau chi can bam dup "day-len-github.bat"
echo   de day moi thay doi len GitHub.
echo ============================================================
echo.
pause
