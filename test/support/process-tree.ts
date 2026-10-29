// What the operating system says about the processes a browser started: the browser process, and
// every process below it (its renderers, GPU and utility processes, and on Linux the zygote that
// forks the renderers). Tests use it to end a renderer, the way a tab crashes, and to check that
// nothing a driver started is still running once its session has closed.
// A zombie (a process that has exited but whose parent has not yet collected its status) counts
// as exited: it runs nothing and holds nothing but its process table entry.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';

export type RunningProcess = { readonly processId: number; readonly parentProcessId: number; readonly commandLine: string };

// The fields of /proc/<id>/stat after the command name, which is in brackets and may itself hold
// spaces or brackets: state, then the parent process id.
function linuxStatus(processId: number): { readonly state: string; readonly parentProcessId: number } | null {
  try {
    const status = readFileSync(`/proc/${processId}/stat`, 'utf8');
    const fields = status.slice(status.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0] ?? '', parentProcessId: Number(fields[1]) };
  } catch {
    return null;
  }
}

function linuxProcesses(): RunningProcess[] {
  const processes: RunningProcess[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const processId = Number(name);
    const status = linuxStatus(processId);
    if (status === null || status.state === 'Z') continue;
    let commandLine = '';
    try { commandLine = readFileSync(`/proc/${processId}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch { /* gone */ }
    processes.push({ processId, parentProcessId: status.parentProcessId, commandLine });
  }
  return processes;
}

type WindowsProcess = { readonly ProcessId?: unknown; readonly ParentProcessId?: unknown; readonly CommandLine?: unknown };

// 'maxBuffer' is Node's own option name.
function windowsProcesses(): RunningProcess[] {
  const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, ['maxBuffer']: 64 * 1024 * 1024 });
  if (query.status !== 0) throw new Error(`listing processes failed: ${query.stderr}`);
  const parsed: unknown = JSON.parse(query.stdout);
  const entries: readonly WindowsProcess[] = Array.isArray(parsed) ? parsed : [parsed as WindowsProcess];
  return entries.map((entry) => ({
    processId: Number(entry.ProcessId),
    parentProcessId: Number(entry.ParentProcessId),
    commandLine: typeof entry.CommandLine === 'string' ? entry.CommandLine : '',
  }));
}

function otherProcesses(): RunningProcess[] {
  const query = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' });
  if (query.status !== 0) throw new Error(`listing processes failed: ${query.stderr}`);
  return query.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match === null ? [] : [{ processId: Number(match[1]), parentProcessId: Number(match[2]), commandLine: match[3] ?? '' }];
  });
}

// Every process running now.
export function listProcesses(): RunningProcess[] {
  if (platform() === 'linux') return linuxProcesses();
  if (platform() === 'win32') return windowsProcesses();
  return otherProcesses();
}

// The process and every process below it, the process itself first.
export function processTree(rootProcessId: number, processes: readonly RunningProcess[] = listProcesses()): RunningProcess[] {
  const tree = processes.filter((candidate) => candidate.processId === rootProcessId);
  const seen = new Set(tree.map((member) => member.processId));
  for (let index = 0; index < tree.length; index++) {
    const parent = tree[index];
    if (parent === undefined) continue;
    for (const candidate of processes) {
      if (candidate.parentProcessId === parent.processId && !seen.has(candidate.processId)) {
        seen.add(candidate.processId);
        tree.push(candidate);
      }
    }
  }
  return tree;
}

// Chromium starts each renderer with this switch on its command line.
const RENDERER_SWITCH = '--type=renderer';

// The renderer processes below a browser process: the processes that run its pages.
export const rendererProcesses = (browserProcessId: number): RunningProcess[] =>
  processTree(browserProcessId).filter((member) => member.commandLine.includes(RENDERER_SWITCH));

// Whether the process still runs. A zombie has exited.
export function isRunning(processId: number): boolean {
  if (platform() === 'linux') {
    const status = linuxStatus(processId);
    return status !== null && status.state !== 'Z';
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// The processes of the list that are still running.
export const stillRunning = (processes: readonly RunningProcess[]): RunningProcess[] =>
  processes.filter((member) => isRunning(member.processId));

// Ends a process at once, as the operating system ends a crashed one: it gets no chance to clean up.
export function endAtOnce(processId: number): void {
  try { process.kill(processId, 'SIGKILL'); } catch { /* already gone */ }
}
