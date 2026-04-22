$edgePath = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (!(Test-Path $edgePath)) {
    $edgePath = "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
}

# Inicia o Edge em modo Aplicativo (sem barras de navegação)
Start-Process $edgePath -ArgumentList "--app=http://localhost:5173", "--window-size=380,680"

# Tempo para a janela carregar e ser encontrada
Start-Sleep -Seconds 3

# Código C# para injetar a função de Sempre no Topo (Win32 API)
$code = @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_SHOWWINDOW = 0x0040;
}
"@

Add-Type -TypeDefinition $code

# Busca a janela pelo título exato configurado no App.jsx
$targetTitle = "*MEGA EXECUTIVE*"
$maxAttempts = 10
$attempt = 0

while ($attempt -lt $maxAttempts) {
    $window = Get-Process | Where-Object { $_.MainWindowTitle -like $targetTitle } | Select-Object -First 1
    if ($window) {
        # Define como SEMPRE NO TOPO
        [Win32]::SetWindowPos($window.MainWindowHandle, [Win32]::HWND_TOPMOST, 0, 0, 0, 0, [Win32]::SWP_NOMOVE -bor [Win32]::SWP_NOSIZE -bor [Win32]::SWP_SHOWWINDOW)
        Write-Host "[OK] MEGA fixado no primeiro plano."
        break
    }
    Start-Sleep -Seconds 1
    $attempt++
}
