import { readFileSync } from 'node:fs'
import * as cmd from './commands.ts'
import { DriftError } from './git.ts'

const USAGE = `drift: keep a fork rebased on upstream releases, carrying its mods.

  drift init --upstream <url> --build <cmd> [--test <cmd>] [--install <cmd>] [--launch <cmd>]
             [--track tags|<branch>] [--tag-pattern <glob>] [--base <rev>] [--remote <name>]
  drift adopt <sha> --request <text>|--request-file <path|-> --check <check>
  drift mod commit --request <text>|--request-file <path|-> --check <check> [-m <subject>]
  drift mod amend <NNN> [--request <text>|--request-file <path|->] [--check <check>]
  drift config <key> <value>
  drift status [--offline]
  drift sync start [--to <tag>] [--without NNN,...] [--unattended]
  drift sync continue
  drift sync fixup <NNN>
  drift verify
  drift sync finish [--unattended]
  drift sync accept | discard | abort [--reason <text>]
  drift report

A check is a shell command, \`build\`, or \`launch [cmd]\`.
Output is JSON. Exit codes: 0 ok, 1 refused or red, 2 conflict to resolve, 3 held for review.`

const BOOLEAN = new Set(['unattended', 'offline', 'help'])

function parse(argv: string[]) {
  const pos: string[] = []
  const opt: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-m') opt.message = argv[++i]
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s)
      const key = k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      opt[key] = v !== undefined ? v : BOOLEAN.has(k) ? true : argv[++i]
    } else pos.push(a)
  }
  return { pos, opt }
}

function str(opt: Record<string, string | true>, key: string): string | undefined {
  const v = opt[key]
  if (v === undefined) return undefined
  if (v === true) throw new DriftError(`--${key} needs a value`)
  return v
}

function need(opt: Record<string, string | true>, key: string): string {
  const v = str(opt, key)
  if (v === undefined) throw new DriftError(`missing --${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`)
  return v
}

function request(opt: Record<string, string | true>, required: boolean): string | undefined {
  const file = str(opt, 'requestFile')
  if (file) return readFileSync(file === '-' ? 0 : file, 'utf8').trim()
  return required ? need(opt, 'request') : str(opt, 'request')
}

async function run(argv: string[]): Promise<cmd.Result> {
  const { pos, opt } = parse(argv)
  const [a, b, c] = pos
  if (!a || opt.help) return { code: 0, json: { usage: USAGE } }
  switch (a) {
    case 'init':
      return cmd.init({
        upstream: need(opt, 'upstream'),
        build: need(opt, 'build'),
        test: str(opt, 'test'),
        install: str(opt, 'install'),
        launch: str(opt, 'launch'),
        track: str(opt, 'track'),
        tagPattern: str(opt, 'tagPattern'),
        base: str(opt, 'base'),
        remote: str(opt, 'remote'),
      })
    case 'adopt':
      if (!b) throw new DriftError('usage: drift adopt <sha> --request ... --check ...')
      return cmd.adopt(b, request(opt, true)!, need(opt, 'check'))
    case 'mod':
      if (b === 'commit') return cmd.modCommit(request(opt, true)!, need(opt, 'check'), str(opt, 'message'))
      if (b === 'amend' && c) return cmd.modAmend(c, request(opt, false), str(opt, 'check'))
      break
    case 'config':
      if (b && c !== undefined) return cmd.configSet(b, c)
      break
    case 'status':
      return cmd.status(!opt.offline)
    case 'verify':
      return cmd.verifyCmd()
    case 'report':
      return cmd.latestReport()
    case 'sync':
      switch (b) {
        case 'start':
          return cmd.syncStart({
            to: str(opt, 'to'),
            without: (str(opt, 'without') ?? '').split(',').filter(Boolean),
            unattended: !!opt.unattended,
          })
        case 'continue':
          return cmd.syncContinue()
        case 'fixup':
          if (c) return cmd.syncFixup(c)
          break
        case 'finish':
          return cmd.syncFinish(!!opt.unattended)
        case 'accept':
          return cmd.syncAccept()
        case 'discard':
          return cmd.syncDiscard()
        case 'abort':
          return cmd.syncAbort(str(opt, 'reason'))
      }
  }
  throw new DriftError(`unknown command: ${argv.join(' ')}\n\n${USAGE}`)
}

export async function main(argv: string[]): Promise<void> {
  try {
    const r = await run(argv)
    if (r.json.usage) process.stdout.write(`${r.json.usage}\n`)
    else process.stdout.write(JSON.stringify(r.json, null, 2) + '\n')
    process.exitCode = r.code
  } catch (e) {
    if (!(e instanceof DriftError)) throw e
    process.stdout.write(JSON.stringify({ status: 'error', error: e.message, ...e.detail }, null, 2) + '\n')
    process.exitCode = 1
  }
}
