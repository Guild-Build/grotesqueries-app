// Controlled qualification witness. ReadConsoleW avoids the Windows/.NET UTF-8
// byte-console path (dotnet/runtime#43295); exact received UTF-16 remains asserted.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const WINDOWS_CONSOLE_FIXTURE_SOURCE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
public static class GuildWideConsoleFixture {
  const uint EnableProcessedInput=0x0001;
  const uint EnableLineInput=0x0002;
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleMode(IntPtr input,out uint mode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleMode(IntPtr input,uint mode);
  [DllImport("kernel32.dll", EntryPoint="ReadConsoleW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ReadConsole(IntPtr input,[Out] StringBuilder buffer,uint length,out uint read,IntPtr control);
  [DllImport("kernel32.dll", EntryPoint="WriteConsoleW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool WriteConsole(IntPtr output,string buffer,uint length,out uint written,IntPtr reserved);
  static void WriteLine(string text) {
    string remaining=text+"\r\n";
    while (remaining.Length>0) {
      uint written;
      if (!WriteConsole(GetStdHandle(-11),remaining,(uint)remaining.Length,out written,IntPtr.Zero) || written==0)
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      remaining=remaining.Substring((int)written);
    }
  }
  public static void Run(string record) {
    IntPtr input=GetStdHandle(-10);
    uint previousMode, currentMode;
    if (!GetConsoleMode(input,out previousMode) ||
        !SetConsoleMode(input,previousMode|EnableProcessedInput|EnableLineInput) ||
        !GetConsoleMode(input,out currentMode))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    if ((currentMode&(EnableProcessedInput|EnableLineInput))!=(EnableProcessedInput|EnableLineInput))
      throw new InvalidOperationException("WINDOWS_WIDE_CONSOLE_LINE_MODE_UNAVAILABLE");
    // This witness records one ReadConsoleW return per entered line.
    WriteLine("WINDOWS_INPUT_MODE:"+previousMode.ToString()+":"+currentMode.ToString());
    WriteLine("WINDOWS_READY:"+System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
    while (true) {
      var buffer=new StringBuilder(512); uint read;
      if (!ReadConsole(input,buffer,512,out read,IntPtr.Zero))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if (read==0) return;
      string line=buffer.ToString(0,(int)read).TrimEnd('\r','\n');
      var units=new int[line.Length]; for(int index=0;index<line.Length;index++) units[index]=(int)line[index];
      File.AppendAllText(record,String.Join(",",units)+"\n");
      if (line=="grid") WriteLine("WINDOWS_GRID:"+Console.WindowWidth.ToString()+"x"+Console.WindowHeight.ToString());
      else WriteLine("WINDOWS_ECHO:"+line);
    }
  }
}`;
const quote = value => "'" + value.replaceAll("'", "''") + "'";

/** Compile only this fixed fixture; environment stays in child memory, never in source/arguments. */
export function compileWindowsConsoleFixture(directory, powershell, environment) {
  const source = path.join(directory, 'consumer-wide-console.cs'), library = path.join(directory, 'consumer-wide-console.dll');
  fs.writeFileSync(source, WINDOWS_CONSOLE_FIXTURE_SOURCE, { flag: 'wx' });
  const started = performance.now();
  try {
    const command = "$ErrorActionPreference='Stop'; Microsoft.PowerShell.Utility\\Add-Type -Path " + quote(source) +
      ' -OutputAssembly ' + quote(library) + ' -OutputType Library';
    execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { cwd: directory, env: { ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')),
        PSModulePath: path.join(path.dirname(powershell), 'Modules') }, windowsHide: true, timeout: 30000, stdio: 'pipe' });
    return library;
  } catch (error) {
    throw Object.assign(new Error('WINDOWS_WIDE_CONSOLE_COMPILE_FAILED'), { diagnostics: { phase: 'fixture-compile', elapsedMs: Math.round(performance.now() - started),
      timeoutMs: 30000, code: typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null, signal: error.signal ?? null,
      stdoutBytes: Buffer.byteLength(error.stdout ?? ''), stderrBytes: Buffer.byteLength(error.stderr ?? '') } });
  } finally { fs.rmSync(source); }
}

export const windowsConsoleFixtureCommand = (library, record) =>
  `[void][Reflection.Assembly]::LoadFrom(${quote(library)}); [GuildWideConsoleFixture]::Run(${quote(record)})`;
