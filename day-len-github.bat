@echo off
chcp 65001 >nul
title Day code len GitHub - Chrome Manager by UP Media
cd /d "%~dp0"

echo ============================================================
echo   DAY CODE LEN GITHUB  (Chrome Manager by UP Media)
echo ============================================================
echo.

REM Tu tim Git neu chua nam trong PATH
where git >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
where git >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "PATH=%ProgramFiles(x86)%\Git\cmd;%PATH%"
where git >nul 2>nul
if errorlevel 1 if exist "%LocalAppData%\Programs\Git\cmd\git.exe" set "PATH=%LocalAppData%\Programs\Git\cmd;%PATH%"
where git >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay Git. Mo file "CAI-DAT-LAN-DAU.bat" truoc, hoac tai Git tai: https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

if not exist ".git" (
  echo [LOI] Thu muc nay chua duoc thiet lap Git.
  echo        Hay chay "CAI-DAT-LAN-DAU.bat" mot lan dau tien.
  echo.
  pause
  exit /b 1
)

echo Dang luu thay doi...
git add -A

REM Neu khong co gi thay doi thi bao va thoat
git diff --cached --quiet
if not errorlevel 1 (
  echo Khong co thay doi nao de day len. Moi thu da duoc dong bo.
  echo.
  pause
  exit /b 0
)

for /f "tokens=1-5 delims=/:. " %%a in ("%date% %time%") do set STAMP=%%a-%%b-%%c %%d:%%e
git commit -m "Cap nhat %STAMP%"

echo.
echo Dang dong bo voi GitHub truoc khi day...
git config pull.rebase false >nul 2>nul
git pull --no-edit origin main
if errorlevel 1 (
  echo.
  echo [LOI] Dong bo that bai ^(co the do xung dot^). Nhan Claude de xu ly giup.
  echo.
  pause
  exit /b 1
)

echo Dang day len GitHub...
git push
if errorlevel 1 (
  echo.
  echo [LOI] Day len that bai. Thuong do:
  echo   - Lan dau chua dang nhap GitHub: se hien cua so dang nhap, dang nhap xong chay lai file nay.
  echo   - Hoac mang dang gian doan.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   DA DAY LEN GITHUB THANH CONG!
echo   GitHub se tu dong build file .exe (~10-15 phut) va bao Telegram.
echo ============================================================
echo.
pause
