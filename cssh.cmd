@echo off
rem cssh - clean ssh client.  Usage:  cssh            (prompt for host)
rem                                   cssh user@host  (connect straight away)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
