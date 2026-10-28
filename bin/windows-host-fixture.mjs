// Qualification-only Windows controller. Never imported by the application runtime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const encoded = source => Buffer.from(source, 'utf16le').toString('base64');
const COMMAND_MS = 30000, DRAIN_MS = 5000;

// A private self-containing job closes the creation/assignment race: children inherit
// this innermost job atomically. Only this controller owns its non-inheritable handle.
// No breakaway or UI restrictions. Refused nesting fails BEFORE any host is created.
export const WINDOWS_CONTROLLER_SOURCE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
public static class GuildFixtureController {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,width,height,charsX,charsY,fill,flags; public short show,reservedBytes;
    public IntPtr reservedPointer,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Created { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long processTime,jobTime; public uint flags; public UIntPtr min,max;
    public uint active; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Limits basic; public Counters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended info,uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint length,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,
    IntPtr processSecurity,IntPtr threadSecurity,bool inheritHandles,uint flags,IntPtr environment,string directory,ref Startup startup,out Created created);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint code,uint group);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
  static void Require(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static void Emit(string nonce,string phase,string payload) { Console.WriteLine("GQ|"+nonce+"|"+phase+"|"+payload); Console.Out.Flush(); }
  static string ReadBoundedLine(int maximum) {
    var line=new StringBuilder();
    while (true) {
      int next=Console.In.Read(); if (next<0) throw new InvalidOperationException("eof");
      if (next==10) return line.ToString();
      if (line.Length>=maximum || next==13) throw new InvalidOperationException("input-bound");
      line.Append((char)next);
    }
  }
  public static void Run(string executable,string directory,string nonce,string fault) {
    IntPtr job=IntPtr.Zero,block=IntPtr.Zero; Created owned=new Created(); bool released=false;
    try {
      job=CreateJobObject(IntPtr.Zero,null); Require(job!=IntPtr.Zero);
      var limits=new Extended(); limits.basic.flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE only
      Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))));
      Require(AssignProcessToJobObject(job,GetCurrentProcess()));
      Emit(nonce,"job-ready","-");
      // Environment stays memory-only: never write credentials into fixture scratch or arguments.
      var prefix=nonce+" env "; var frame=ReadBoundedLine(180000);
      if (!frame.StartsWith(prefix,StringComparison.Ordinal)) throw new InvalidOperationException("environment-nonce");
      var environment=Convert.FromBase64String(frame.Substring(prefix.Length));
      if (environment.Length<4 || environment.Length>131072 || environment.Length%2!=0 ||
        environment[environment.Length-1]!=0 || environment[environment.Length-2]!=0 ||
        environment[environment.Length-3]!=0 || environment[environment.Length-4]!=0) throw new InvalidOperationException("environment-bound");
      block=Marshal.AllocHGlobal(environment.Length); Marshal.Copy(environment,0,block,environment.Length);
      var startup=new Startup(); startup.cb=Marshal.SizeOf(typeof(Startup)); startup.flags=1; startup.show=0;
      Require(CreateProcess(executable,new StringBuilder("\""+executable+"\""),IntPtr.Zero,IntPtr.Zero,false,
        0x414,block,directory,ref startup,out owned)); // NEW_CONSOLE | SUSPENDED | UNICODE_ENVIRONMENT
      Marshal.FreeHGlobal(block); block=IntPtr.Zero;
      long birth,end,kernel,user; Require(GetProcessTimes(owned.process,out birth,out end,out kernel,out user));
      Emit(nonce,"created",owned.pid.ToString()+","+birth.ToString());
      if (fault=="after-create") Environment.Exit(72); // native containment fault test; host has never executed
      if (ReadBoundedLine(64)!=nonce+" resume") throw new InvalidOperationException("ack");
      if (ResumeThread(owned.thread)!=1) throw new InvalidOperationException("resume");
      CloseHandle(owned.thread); owned.thread=IntPtr.Zero; Emit(nonce,"resumed","-");
      while (true) {
        var command=ReadBoundedLine(64);
        if (command==nonce+" stop") {
          uint wait=WaitForSingleObject(owned.process,0);
          if (wait==0xffffffff) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
          if (wait!=0) {
            long current; Require(GetProcessTimes(owned.process,out current,out end,out kernel,out user));
            if (current!=birth) throw new InvalidOperationException("generation");
            var image=new StringBuilder(32768); uint length=32768;
            Require(QueryFullProcessImageName(owned.process,0,image,ref length));
            if (!String.Equals(Path.GetFullPath(image.ToString()),executable,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("image");
            FreeConsole(); Require(AttachConsole(owned.pid));
            try {
              Require(SetConsoleCtrlHandler(IntPtr.Zero,true)); // AttachConsole resets handler table
              Require(GenerateConsoleCtrlEvent(0,0)); System.Threading.Thread.Sleep(300);
            } finally { Require(FreeConsole()); }
          }
          Emit(nonce,"signaled","-");
        } else if (command==nonce+" dispose") {
          if (WaitForSingleObject(owned.process,0)!=0) throw new InvalidOperationException("host-live");
          var drain=System.Diagnostics.Stopwatch.StartNew();
          while (true) {
            Accounting accounting; Require(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
            if (accounting.active==1) break;
            if (drain.ElapsedMilliseconds>=4000) throw new InvalidOperationException("job-not-empty");
            System.Threading.Thread.Sleep(20);
          }
          // Only the controller remains. No application process can create new children.
          limits.basic.flags=0; Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))));
          Require(CloseHandle(job)); job=IntPtr.Zero; CloseHandle(owned.process); owned.process=IntPtr.Zero;
          released=true; Emit(nonce,"disposed","-"); return;
        } else { throw new InvalidOperationException("command"); }
      }
    } catch (Exception error) {
      var native=error as System.ComponentModel.Win32Exception;
      Emit(nonce,"failure",native==null ? "0" : native.NativeErrorCode.ToString());
      Environment.Exit(71); // process teardown closes its sole job handle; containment is a FAILED qualification
    } finally {
      if (block!=IntPtr.Zero) Marshal.FreeHGlobal(block);
      if (owned.thread!=IntPtr.Zero) CloseHandle(owned.thread);
      if (owned.process!=IntPtr.Zero) CloseHandle(owned.process);
      if (job!=IntPtr.Zero) CloseHandle(job);
      if (!released) Environment.Exit(71);
    }
  }
}`;

/** A bounded Unicode Win32 environment block; helper-only variables never leak into the app. */
export function windowsEnvironmentBlock(environment) {
  const seen = new Set(), entries = Object.entries(environment).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_()]*$/.test(name) || typeof value !== 'string' || value.includes('\0') || seen.has(name.toUpperCase())) throw new Error('WINDOWS_FIXTURE_ENVIRONMENT_INVALID');
    seen.add(name.toUpperCase()); return [name, value];
  });
  entries.sort(([a], [b]) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);
  const bytes = Buffer.from(entries.map(([name, value]) => name + '=' + value).join('\0') + '\0\0', 'utf16le');
  if (bytes.length > 128 * 1024) throw new Error('WINDOWS_FIXTURE_ENVIRONMENT_LIMIT');
  return bytes;
}

function systemPowerShell(environment) {
  const windows = Object.entries(environment).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
  if (!/^[A-Za-z]:[\\/]/.test(windows ?? '')) throw new Error('WINDOWS_HOST_FIXTURE_SYSTEMROOT');
  return { powershell: path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    modules: path.join(windows, 'System32/WindowsPowerShell/v1.0/Modules') };
}
function machineModuleEnvironment(environment, modules) {
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')), PSModulePath: modules };
}
const line = (nonce, phase, payload = '-') => `GQ|${nonce}|${phase}|${payload}`;
const phaseSource = (nonce, phase) => `[Console]::WriteLine(${quote(line(nonce, phase))}); [Console]::Out.Flush();`;

/** Strict receipt channel, also exercised with portable stream fixtures. */
export function controllerChannel(child, nonce) {
  let pending = '', bytes = 0, stderrBytes = 0, closed, failure;
  const messages = [], phases = []; const started = Date.now();
  child.stdout.on('data', data => {
    bytes += data.length;
    if (bytes > 65536) { failure = new Error('WINDOWS_CONTROLLER_OUTPUT_LIMIT'); return; }
    pending += data.toString('utf8');
    while (pending.includes('\n')) {
      const index = pending.indexOf('\n'), value = pending.slice(0, index).replace(/\r$/, ''); pending = pending.slice(index + 1);
      const match = /^GQ\|([a-f0-9]{32})\|(started|type-ready|job-ready|created|resumed|signaled|disposed|failure)\|(-|[0-9]+(?:,[0-9]+)?)$/.exec(value);
      if (!match || match[1] !== nonce || (match[2] === 'created' ? !/^[1-9][0-9]*,[1-9][0-9]*$/.test(match[3]) : match[2] === 'failure' ? !/^\d+$/.test(match[3]) : match[3] !== '-')) {
        failure = new Error('WINDOWS_CONTROLLER_RECEIPT_INVALID'); continue;
      }
      messages.push({ phase: match[2], payload: match[3] }); phases.push({ phase: match[2], elapsedMs: Date.now() - started });
      if (match[2] === 'failure') failure = new Error('WINDOWS_CONTROLLER_NATIVE_FAILURE_' + match[3]);
    }
    if (pending.length > 4096) failure = new Error('WINDOWS_CONTROLLER_LINE_LIMIT');
  });
  child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > 65536) failure = new Error('WINDOWS_CONTROLLER_STDERR_LIMIT'); });
  child.on('error', error => { failure = new Error('WINDOWS_CONTROLLER_SPAWN_FAILED'); failure.code = /^[A-Z_0-9]+$/.test(error.code ?? '') ? error.code : 'UNKNOWN'; });
  child.on('close', (code, signal) => { closed = { code, signal }; if (pending) failure ??= new Error('WINDOWS_CONTROLLER_TRUNCATED_RECEIPT'); });
  const diagnostics = () => ({ phases, elapsedMs: Date.now() - started, stdoutBytes: bytes, stderrBytes, code: closed?.code ?? null, signal: closed?.signal ?? null,
    timeoutMs: COMMAND_MS, drainTimeoutMs: DRAIN_MS, killed: child.killed === true, spawnCode: failure?.code ?? null });
  function healthy() { if (failure) throw failure; if (closed) throw new Error('WINDOWS_CONTROLLER_UNEXPECTED_EXIT'); }
  async function receive(phase, timeoutMs = COMMAND_MS) {
    const deadline = Date.now() + timeoutMs;
    while (!messages.length) { healthy(); if (Date.now() >= deadline) throw new Error('WINDOWS_CONTROLLER_TIMEOUT_' + phase); await pause(10); }
    if (failure) throw failure;
    const message = messages.shift(); if (message.phase !== phase) throw new Error('WINDOWS_CONTROLLER_PHASE_' + phase);
    return message.payload;
  }
  async function finish(timeoutMs = DRAIN_MS) {
    const deadline = Date.now() + timeoutMs;
    while (!closed) { if (failure) throw failure; if (Date.now() >= deadline) throw new Error('WINDOWS_CONTROLLER_DRAIN_TIMEOUT'); await pause(10); }
    if (failure) throw failure;
    if (closed.code !== 0 || closed.signal || messages.length || pending) throw new Error('WINDOWS_CONTROLLER_EXIT_FAILED');
  }
  return { receive, finish, healthy, diagnostics, send(command) {
    healthy(); if (messages.length) throw new Error('WINDOWS_CONTROLLER_UNEXPECTED_RECEIPT');
    if (!['resume', 'stop', 'dispose'].includes(command)) throw new Error('WINDOWS_CONTROLLER_COMMAND');
    child.stdin.write(nonce + ' ' + command + '\n');
  }, sendEnvironment(bytes) {
    healthy(); if (messages.length || !Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > 128 * 1024 || bytes.length % 2 || bytes.readUInt32LE(bytes.length - 4) !== 0) throw new Error('WINDOWS_CONTROLLER_ENVIRONMENT_FRAME');
    child.stdin.write(nonce + ' env ' + bytes.toString('base64') + '\n');
  }, async abort() {
    if (!closed) { child.kill(); const deadline = Date.now() + DRAIN_MS; while (!closed && Date.now() < deadline) await pause(10); }
    if (!closed) throw new Error('WINDOWS_CONTROLLER_ABORT_TIMEOUT');
  } };
}

async function probe(powershell, cwd, environment, label, qualified) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const source = "$ErrorActionPreference='Stop';" + phaseSource(nonce, 'started') +
    `${qualified ? 'Microsoft.PowerShell.Utility\\' : ''}Add-Type -TypeDefinition 'public static class GuildNoHostProbe { public static int Ready(){return 1;} }';` + phaseSource(nonce, 'type-ready');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(source)], { cwd, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const channel = controllerChannel(child, nonce); let result;
  try { await channel.receive('started'); await channel.receive('type-ready', Math.max(1, COMMAND_MS - channel.diagnostics().elapsedMs)); await channel.finish(Math.max(1, COMMAND_MS - channel.diagnostics().elapsedMs)); result = { passed: true }; }
  catch (error) { result = { passed: false, failure: error.message }; await channel.abort(); }
  return { label, ...result, ...channel.diagnostics() };
}

/** No application process is created by these three independent, bounded startup/compile probes. */
export async function probeWindowsPowerShell(cwd, environment) {
  const { powershell, modules } = systemPowerShell(environment);
  const results = [];
  for (const [label, env, qualified] of [['inherited-control', process.env, false], ['stripped-app', environment, false],
    ['machine-modules', machineModuleEnvironment(environment, modules), true]]) {
    results.push(await probe(powershell, cwd, env, label, qualified));
    console.log('Windows no-host PowerShell probe: ' + JSON.stringify(results.at(-1)));
  }
  const report = path.join(process.cwd(), '.runtime/verification/windows-powershell-probes.json');
  fs.mkdirSync(path.dirname(report), { recursive: true }); fs.writeFileSync(report, JSON.stringify({ noHostCreated: true, results }, null, 2) + '\n');
  if (!results.at(-1).passed) throw new Error('WINDOWS_POWERSHELL_CONTROL_PROBE_FAILED');
  return results;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

export async function startOwnedWindowsHost(executable, cwd, environment, { fault, onCreated, reportDirectory = path.join(process.cwd(), '.runtime/verification') } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_HOST_FIXTURE_UNSUPPORTED');
  executable = path.resolve(executable); cwd = path.resolve(cwd);
  if (!/^[A-Za-z]:[\\/]/.test(executable) || path.basename(executable).toLowerCase() !== 'grotesqueries.exe' ||
    !fs.lstatSync(executable).isFile() || fs.lstatSync(executable).isSymbolicLink() || !fs.lstatSync(cwd).isDirectory() ||
    (fault !== undefined && fault !== 'after-create')) throw new Error('WINDOWS_HOST_FIXTURE_INVALID');
  const { powershell, modules } = systemPowerShell(environment), nonce = crypto.randomBytes(16).toString('hex');
  const environmentBytes = windowsEnvironmentBlock(environment);
  const sourceFile = path.join(cwd, '.guild-fixture-' + nonce + '.cs');
  const source = "$ErrorActionPreference='Stop';" + phaseSource(nonce, 'started') +
    `Microsoft.PowerShell.Utility\\Add-Type -Path ${quote(sourceFile)};` + phaseSource(nonce, 'type-ready') +
    `[GuildFixtureController]::Run(${[executable, cwd, nonce, fault ?? ''].map(quote).join(',')});`;
  fs.writeFileSync(sourceFile, WINDOWS_CONTROLLER_SOURCE, { flag: 'wx' });
  let child;
  try { child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(source)],
    { cwd, env: machineModuleEnvironment(environment, modules), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { fs.rmSync(sourceFile); throw new Error('WINDOWS_CONTROLLER_SPAWN_FAILED', { cause: error }); }
  const channel = controllerChannel(child, nonce); child.stdin.on('error', () => {});
  const removeInputs = () => { fs.rmSync(sourceFile); };
  const report = () => {
    const file = path.join(reportDirectory, 'windows-controller-' + nonce + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(channel.diagnostics(), null, 2) + '\n');
  };
  try {
    const remaining = () => Math.max(1, COMMAND_MS - channel.diagnostics().elapsedMs);
    for (const phase of ['started', 'type-ready', 'job-ready']) await channel.receive(phase, remaining());
    channel.sendEnvironment(environmentBytes);
    const identity = await channel.receive('created', remaining()), [rawPid, birth] = identity.split(','), pid = Number(rawPid);
    if (!Number.isSafeInteger(pid) || pid > 0xffffffff || !/^\d{1,20}$/.test(birth)) throw new Error('WINDOWS_HOST_FIXTURE_IDENTITY');
    if (onCreated) await onCreated({ pid, birth });
    channel.send('resume'); await channel.receive('resumed', remaining());
    let stopping, disposed = false;
    return { pid, birth, assertHealthy: channel.healthy, async stop() {
      if (disposed) return;
      if (stopping) return stopping;
      const attempt = (async () => {
        channel.send('stop'); await channel.receive('signaled');
        const deadline = Date.now() + COMMAND_MS;
        while (alive(pid)) { channel.healthy(); if (Date.now() >= deadline) throw new Error('WINDOWS_HOST_FIXTURE_SHUTDOWN_TIMEOUT'); await pause(25); }
        channel.healthy();
      })();
      stopping = attempt; void attempt.catch(() => { if (stopping === attempt) stopping = undefined; }); return attempt;
    }, async dispose() {
      if (disposed) return;
      const deadline = Date.now() + DRAIN_MS;
      channel.send('dispose'); await channel.receive('disposed', DRAIN_MS);
      await channel.finish(Math.max(1, deadline - Date.now())); disposed = true; removeInputs(); report();
    }, async abort() { await channel.abort(); report(); } };
  } catch (error) {
    try { await channel.abort(); removeInputs(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'WINDOWS_CONTROLLER_START_CLEANUP_FAILED'); }
    finally { report(); }
    throw new Error('WINDOWS_CONTROLLER_START_FAILED: ' + error.message, { cause: error });
  }
}
