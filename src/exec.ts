import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RunResult {
  ok: boolean
  code: number | null
  log: string
  tail: string
}

function tail(log: string, n = 40): string {
  return readFileSync(log, 'utf8').split('\n').slice(-n).join('\n').trim()
}

/** Runs a shell command with output captured to `log`. */
export function runShell(cmd: string, cwd: string, log: string): RunResult {
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'w')
  const r = spawnSync('sh', ['-c', cmd], { cwd, stdio: ['ignore', fd, fd], env: process.env })
  closeSync(fd)
  return { ok: r.status === 0, code: r.status, log, tail: tail(log) }
}

/** `check: launch`: start the app, wait, require it to still be alive, then kill it. */
export async function runLaunch(cmd: string, cwd: string, log: string, waitSeconds: number): Promise<RunResult> {
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'w')
  const child = spawn('sh', ['-c', cmd], { cwd, stdio: ['ignore', fd, fd], detached: true, env: process.env })
  let exited: number | null | undefined
  const done = new Promise<void>((res) => child.on('exit', (code) => ((exited = code), res())))
  await Promise.race([done, new Promise((res) => setTimeout(res, waitSeconds * 1000))])
  const alive = exited === undefined
  if (alive) {
    try {
      process.kill(-child.pid!, 'SIGTERM')
    } catch {}
    await Promise.race([done, new Promise((res) => setTimeout(res, 3000))])
    if (exited === undefined)
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {}
  }
  closeSync(fd)
  return { ok: alive, code: alive ? 0 : (exited ?? null), log, tail: tail(log) }
}
