// The host's own clipboard, which no run may read or change. Tests of the run-local clipboard use
// it in two ways:
//
//   - guardHostClipboard() protects the clipboard of the person running the tests while a test
//     file makes pages copy text. On Windows it takes a snapshot of every format the clipboard
//     holds before the file runs, and puts the snapshot back afterwards only if the clipboard
//     changed meanwhile. On Linux and macOS it hides the person's display from the browsers the
//     file starts (DISPLAY and WAYLAND_DISPLAY), so a headless browser has no host clipboard to
//     reach.
//   - openHostClipboard() gives the isolation proof a host clipboard it may write a canary to. On
//     Windows that is the system clipboard, saved first and always restored. On Linux it is the
//     clipboard of a private virtual X display the test starts itself (Xvfb, read and written with
//     xclip), so the person's own display is never touched; browsers started meanwhile see it as
//     their display.
//
// When the Windows clipboard holds data that cannot be copied whole, such as a format an
// application renders only on request, nothing is written and the tests that would copy are
// skipped with that reason, so the person's clipboard is never lost.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

// ---- Windows: one long-lived PowerShell process that owns the snapshot --------------------------

// Reads commands from standard input, one per line, and answers each with one line of JSON:
//   snapshot         copies every format on the clipboard into memory; lists the formats it
//                    copied and any it could not read
//   sequence         the clipboard's sequence number, which changes on every write
//   write <base64>   puts UTF-8 text on the clipboard, and waits until it reads back
//   read             the clipboard's text, as base64 UTF-8 ("" when it holds none)
//   restore          puts the snapshot back, or empties the clipboard if the snapshot was empty
// Clipboard calls are retried, since another application may hold the clipboard for a moment.
const WINDOWS_CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace RevisumTests -Name ClipboardSequence -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
$snapshot = $null
$snapshotHeldData = $false
function Send-Reply($reply) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Compress)); [Console]::Out.Flush() }
function Invoke-WithRetry([scriptblock]$action) {
  for ($attempt = 1; ; $attempt++) {
    try { return (& $action) } catch { if ($attempt -ge 20) { throw }; Start-Sleep -Milliseconds 100 }
  }
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'exit') { break }
  $parts = $line.Split(' ', 2)
  try {
    if ($parts[0] -eq 'snapshot') {
      $source = Invoke-WithRetry { [System.Windows.Forms.Clipboard]::GetDataObject() }
      $copy = New-Object System.Windows.Forms.DataObject
      $formats = @()
      $unreadable = @()
      if ($null -ne $source) {
        foreach ($format in $source.GetFormats($false)) {
          $data = $null
          try { $data = $source.GetData($format, $false) } catch { $data = $null }
          if ($null -eq $data) { $unreadable += $format }
          else {
            if ($data -is [System.IO.MemoryStream]) { $data = New-Object System.IO.MemoryStream -ArgumentList (,$data.ToArray()) }
            $copy.SetData($format, $false, $data)
            $formats += $format
          }
        }
      }
      $snapshot = $copy
      $snapshotHeldData = $formats.Count -gt 0
      Send-Reply @{ ok = $true; formats = @($formats); unreadable = @($unreadable) }
    } elseif ($parts[0] -eq 'sequence') {
      Send-Reply @{ ok = $true; sequence = [RevisumTests.ClipboardSequence]::GetClipboardSequenceNumber() }
    } elseif ($parts[0] -eq 'write') {
      $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($parts[1]))
      Invoke-WithRetry { [System.Windows.Forms.Clipboard]::SetText($text) }
      for ($check = 0; $check -lt 20; $check++) {
        $now = Invoke-WithRetry { [System.Windows.Forms.Clipboard]::GetText() }
        if ($now -ceq $text) { break }
        Start-Sleep -Milliseconds 100
      }
      if ($now -ceq $text) { Send-Reply @{ ok = $true } } else { Send-Reply @{ ok = $false; error = 'the written text did not read back' } }
    } elseif ($parts[0] -eq 'read') {
      $text = Invoke-WithRetry { [System.Windows.Forms.Clipboard]::GetText() }
      Send-Reply @{ ok = $true; text = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$text)) }
    } elseif ($parts[0] -eq 'restore') {
      if ($snapshotHeldData) { Invoke-WithRetry { [System.Windows.Forms.Clipboard]::SetDataObject($snapshot, $true, 20, 100) } }
      else { Invoke-WithRetry { [System.Windows.Forms.Clipboard]::Clear() } }
      Send-Reply @{ ok = $true }
    } else {
      Send-Reply @{ ok = $false; error = 'unknown command' }
    }
  } catch {
    Send-Reply @{ ok = $false; error = $_.Exception.Message }
  }
}
`;

type Reply = Readonly<Record<string, unknown>>;
type WindowsClipboardProcess = { ask(command: string): Promise<Reply>; end(): Promise<void> };

function startWindowsClipboardProcess(): WindowsClipboardProcess {
  const encoded = Buffer.from(WINDOWS_CLIPBOARD_SCRIPT, 'utf16le').toString('base64');
  const child: ChildProcessWithoutNullStreams = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Sta', '-EncodedCommand', encoded], { windowsHide: true });
  const waiting: ((reply: Reply) => void)[] = [];
  let buffered = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { errors += chunk; });
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line === '') continue;
      const parsed: unknown = JSON.parse(line);
      const reply: Reply = typeof parsed === 'object' && parsed !== null ? { ...parsed } : { ok: false, error: line };
      waiting.shift()?.(reply);
    }
  });
  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  child.once('exit', () => {
    for (const answer of waiting.splice(0)) answer({ ok: false, error: `the clipboard process ended: ${errors.trim()}` });
  });
  return {
    ask: (command) => new Promise<Reply>((resolve) => {
      waiting.push(resolve);
      child.stdin.write(`${command}\n`);
    }),
    end: async () => {
      if (child.exitCode === null) child.stdin.end('exit\n');
      await exited;
    },
  };
}

async function askOrThrow(clipboard: WindowsClipboardProcess, command: string): Promise<Reply> {
  const reply = await clipboard.ask(command);
  if (reply['ok'] !== true) throw new Error(`the host clipboard refused "${command.split(' ')[0] ?? ''}": ${String(reply['error'])}`);
  return reply;
}

const listOf = (value: unknown): readonly string[] => (Array.isArray(value) ? value.map(String) : value === undefined || value === null ? [] : [String(value)]);

// Takes the snapshot. Null when it is whole; otherwise why the clipboard cannot be restored.
async function takeSnapshot(clipboard: WindowsClipboardProcess): Promise<string | null> {
  const reply = await clipboard.ask('snapshot');
  if (reply['ok'] !== true) return `the host clipboard could not be read: ${String(reply['error'])}`;
  const unreadable = listOf(reply['unreadable']);
  if (unreadable.length > 0) return `the host clipboard holds data that cannot be saved and restored (${unreadable.join(', ')}); copy plain text and run again`;
  return null;
}

// ---- Protecting the person's clipboard while pages copy --------------------------------------

export type HostClipboardGuard = {
  // Why tests that make pages copy must be skipped here; null when they may run.
  readonly skipReason: string | null;
  // Puts the person's clipboard back if anything changed it, and ends the guard. True when it had changed.
  restore(): Promise<boolean>;
};

const DISPLAY_VARIABLES = ['DISPLAY', 'WAYLAND_DISPLAY'] as const;

function hideDisplays(): () => void {
  const saved = DISPLAY_VARIABLES.map((name) => [name, process.env[name]] as const);
  for (const name of DISPLAY_VARIABLES) delete process.env[name];
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export async function guardHostClipboard(): Promise<HostClipboardGuard> {
  if (platform() !== 'win32') {
    const showDisplays = hideDisplays();
    return { skipReason: null, restore: async () => { showDisplays(); return false; } };
  }
  const clipboard = startWindowsClipboardProcess();
  const problem = await takeSnapshot(clipboard);
  if (problem !== null) {
    await clipboard.end();
    return { skipReason: problem, restore: async () => false };
  }
  const before = (await askOrThrow(clipboard, 'sequence'))['sequence'];
  let ended = false;
  return {
    skipReason: null,
    restore: async () => {
      if (ended) return false;
      ended = true;
      try {
        const now = (await askOrThrow(clipboard, 'sequence'))['sequence'];
        if (now === before) return false;
        await askOrThrow(clipboard, 'restore');
        return true;
      } finally {
        await clipboard.end();
      }
    },
  };
}

// ---- A host clipboard the isolation proof may write to ---------------------------------------

export type HostClipboard = {
  // Why this host has no clipboard the proof can use safely; null when it has one.
  readonly unavailableReason: string | null;
  write(text: string): Promise<void>;
  // The clipboard's text; "" when it holds none.
  read(): Promise<string>;
  // Puts the person's clipboard back (Windows), or stops the private display (Linux). Safe to call twice.
  restore(): Promise<void>;
};

const unavailable = (reason: string): HostClipboard => ({
  unavailableReason: reason,
  write: async () => { throw new Error(reason); },
  read: async () => { throw new Error(reason); },
  restore: async () => undefined,
});

async function windowsHostClipboard(): Promise<HostClipboard> {
  const clipboard = startWindowsClipboardProcess();
  const problem = await takeSnapshot(clipboard);
  if (problem !== null) {
    await clipboard.end();
    return unavailable(problem);
  }
  let ended = false;
  return {
    unavailableReason: null,
    write: async (text) => { await askOrThrow(clipboard, `write ${Buffer.from(text, 'utf8').toString('base64')}`); },
    read: async () => Buffer.from(String((await askOrThrow(clipboard, 'read'))['text'] ?? ''), 'base64').toString('utf8'),
    restore: async () => {
      if (ended) return;
      ended = true;
      try { await askOrThrow(clipboard, 'restore'); } finally { await clipboard.end(); }
    },
  };
}

const commandExists = (name: string): boolean => spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function linuxHostClipboard(): Promise<HostClipboard> {
  const missing = ['Xvfb', 'xclip'].filter((tool) => !commandExists(tool));
  if (missing.length > 0) return unavailable(`the Linux half of this proof needs ${missing.join(' and ')} on the path, as the pinned image should install`);
  // The first display number with no server and no lock file.
  let displayNumber = -1;
  for (let candidate = 99; candidate >= 80; candidate--) {
    if (!existsSync(`/tmp/.X11-unix/X${candidate}`) && !existsSync(`/tmp/.X${candidate}-lock`)) { displayNumber = candidate; break; }
  }
  if (displayNumber < 0) return unavailable('no free X display number between :80 and :99');
  const server = spawn('Xvfb', [`:${displayNumber}`, '-nolisten', 'tcp', '-screen', '0', '1280x720x24'], { stdio: 'ignore' });
  for (let waited = 0; waited < 10_000 && !existsSync(`/tmp/.X11-unix/X${displayNumber}`); waited += 100) await pause(100);
  if (!existsSync(`/tmp/.X11-unix/X${displayNumber}`)) {
    server.kill();
    return unavailable(`the private display :${displayNumber} did not start`);
  }
  // Browsers started from now on inherit the private display; the person's own is hidden.
  const showDisplays = hideDisplays();
  process.env['DISPLAY'] = `:${displayNumber}`;
  let ended = false;
  return {
    unavailableReason: null,
    write: async (text) => {
      // xclip keeps serving the selection from a background copy of itself, which ends with the display.
      const written = spawnSync('xclip', ['-selection', 'clipboard', '-i'], { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000 });
      if (written.status !== 0) throw new Error('xclip could not write the private display\'s clipboard');
    },
    read: async () => {
      const read = spawnSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8', timeout: 10_000 });
      return read.status === 0 ? read.stdout : '';
    },
    restore: async () => {
      if (ended) return;
      ended = true;
      showDisplays();
      const stopped = new Promise<void>((resolve) => { server.once('exit', () => resolve()); });
      server.kill();
      await stopped;
    },
  };
}

export async function openHostClipboard(): Promise<HostClipboard> {
  if (platform() === 'win32') return windowsHostClipboard();
  if (platform() === 'linux') return linuxHostClipboard();
  return unavailable(`this proof runs on Windows and in the pinned Linux image, not on ${platform()}`);
}
