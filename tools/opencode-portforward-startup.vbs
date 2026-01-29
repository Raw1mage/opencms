Set objShell = CreateObject("Shell.Application")
objShell.ShellExecute "powershell.exe", "-ExecutionPolicy Bypass -WindowStyle Hidden -File ""\\wsl.localhost\Ubuntu-24.04\home\pkcs12\opencode\setup-opencode-portforward.ps1""", "", "runas", 0
