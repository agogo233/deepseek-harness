/**
 * Deploy the `@deepseek-ai/dsh` runtime closure into a container image.
 *
 * Mirrors the Python SDK executable carrier: a production-only pnpm deploy,
 * restoration of direct dependencies the legacy hoister places outside the
 * target, dereferenced package links, shared workspace deduplication, and a
 * symlink-free, documentation-stripped payload. The payload is the full
 * runtime: the CLI entry, the Web frontend, the Cordis patch metadata, the
 * native confinement launcher, the Python execution backend, and the
 * platform binaries.
 */

import { existsSync } from 'node:fs'
import { mkdirSync, rmSync } from 'node:fs'
import { cp, glob, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

import { pnpmInvocation, restoreLegacyHoists } from './executable-packaging.ts'
import { deduplicateStagedWorkspacePackages, materializeStagedLinks } from './build-exe-for-python-sdk-staging.ts'

const root = resolve(import.meta.dirname, '..')

/** Platform-specific package suffix for the confinement launcher and search binary. */
const PLATFORM = `linux-${process.arch}`

/** Workspace package whose closure defines the deployed runtime. */
const DEPLOY_ROOT_PACKAGE = '@deepseek-ai/dsh'
/** Deploy source's installed dependencies, where the legacy hoister lands direct packages. */
const DEPLOY_SOURCE_NODE_MODULES = 'apps/cli/node_modules'
/** Documentation files carried by the deployed closure itself, never needed at runtime. */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']
/** Directories removed only when `--strip-src` is passed. */
const STRIP_DIRS = ['src', 'tests', '__tests__', 'docs']
/** Runtime-irrelevant files removed from every package in the payload. */
const STRIP_GLOBS = ['**/*.d.ts', '**/*.d.mts', '**/*.d.cts', '**/*.map', '**/README*.md', '**/CHANGELOG*.md', '**/HISTORY*.md']
/**
 * Workspace packages the production closure omits (peer- or dev-only edges),
 * mapped to their source directories. The container runtime needs them: the
 * PTC execution runtimes, the seam packages their consumers import, and the
 * vendored loader packages.
 */
const RUNTIME_ONLY_PACKAGES: Record<string, string> = {
  '@deepseek-ai/cordis-plugin-group': 'vendor/group',
  '@deepseek-ai/cosmokit': 'vendor/cosmokit',
  '@deepseek-ai/dsh-anonymous-user-id': 'packages/identity/anonymous-user-id',
  '@deepseek-ai/dsh-attachment': 'packages/attachment/attachment',
  '@deepseek-ai/dsh-bash-local': 'packages/shell/bash-local',
  '@deepseek-ai/dsh-client-store': 'packages/client/store',
  '@deepseek-ai/dsh-client-ui-dockkit': 'packages/client/ui-dockkit',
  '@deepseek-ai/dsh-client-ui-primitives': 'packages/client/ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots',
  '@deepseek-ai/dsh-compaction': 'packages/compaction/compaction',
  '@deepseek-ai/dsh-deepseek-account': 'packages/credentials/deepseek-account',
  '@deepseek-ai/dsh-experimental-ptc-runtime-python': 'packages/experimental/ptc-runtime-python',
  '@deepseek-ai/dsh-fs': 'packages/fs/fs',
  '@deepseek-ai/dsh-jobs': 'packages/jobs/jobs',
  '@deepseek-ai/dsh-llm-deepseek': 'packages/llm/llm-deepseek',
  '@deepseek-ai/dsh-ptc-runtime': 'packages/ptc-runtime/ptc-runtime',
  '@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox',
  '@deepseek-ai/dsh-scope': 'packages/core/scope',
  '@deepseek-ai/dsh-sdk-protocol': 'packages/sdk/protocol',
  '@deepseek-ai/dsh-session-persistence': 'packages/session/session-persistence',
  '@deepseek-ai/dsh-session-query': 'packages/session-query/session-query',
  '@deepseek-ai/dsh-session-telemetry': 'packages/session/session-telemetry',
  '@deepseek-ai/dsh-session-title-llm': 'packages/session/session-title-llm',
  '@deepseek-ai/dsh-shell': 'packages/shell/shell',
  '@deepseek-ai/dsh-spill': 'packages/spill/spill',
  '@deepseek-ai/dsh-util-workspace-path': 'packages/util/workspace-path',
  '@deepseek-ai/dsh-workflow': 'packages/workflow/workflow',
}

interface DeployCli {
  readonly out: string
  readonly restoreDev: boolean
  readonly stripSrc: boolean
  readonly dryRun: boolean
}

/** Parse the deploy command line. */
export function parseDeployCli(args: string[]): DeployCli {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: 'string' },
      'no-restore-dev': { type: 'boolean', default: false },
      'strip-src': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  if (typeof values.out !== 'string' || values.out === '') {
    throw new Error('deploy-dsh-runtime: --out <directory> is required')
  }
  return {
    out: resolve(values.out),
    // Legacy deploy records a production-only workspace installation; restoring the
    // development dependencies keeps the tree buildable unless the caller is done.
    restoreDev: !values['no-restore-dev'],
    stripSrc: values['strip-src'],
    dryRun: values['dry-run'],
  }
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? `'${part}'` : part)).join(' ')
}

async function runPnpm(label: string, args: string[], cli: DeployCli): Promise<void> {
  const [command, invocationArgs] = pnpmInvocation(args)
  const printable = formatCommand(command, invocationArgs)
  if (cli.dryRun) {
    console.log(`deploy-dsh-runtime: [dry-run] ${label}: ${printable}`)
    return
  }
  console.log(`deploy-dsh-runtime: ${label}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, invocationArgs, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CI: 'true' },
    })
    child.once('error', (error) => {
      reject(new Error(`deploy-dsh-runtime: ${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`deploy-dsh-runtime: ${label} failed (${cause}): ${printable}`))
    })
  })
}

async function removeGlobs(staging: string, patterns: string[], exclude?: string[]): Promise<void> {
  // fs.glob results are relative to `cwd`; resolve them against the staging root
  // before deleting so a caller's process working directory stays untouched.
  const files = glob(patterns, {
    cwd: staging,
    exclude,
  })
  for await (const file of files) await rm(join(staging, file), { force: true })
}

/** Strip documentation, type declarations, and source maps from the payload. */
async function stripRuntimeDocs(staging: string, cli: DeployCli): Promise<void> {
  for (const name of DEPLOY_ONLY_DOCS) {
    const file = join(staging, name)
    if (cli.dryRun) {
      if (existsSync(file)) console.log(`deploy-dsh-runtime: [dry-run] rm ${file}`)
    } else {
      await rm(file, { force: true })
    }
  }
  if (cli.dryRun) {
    console.log(`deploy-dsh-runtime: [dry-run] rm ${STRIP_GLOBS.join(', ')}`)
    return
  }
  await removeGlobs(staging, STRIP_GLOBS, ['**/assets/**'])
  if (cli.stripSrc) {
    const dirs: string[] = []
    for await (const dir of glob(`**/{${STRIP_DIRS.join(',')}}`, { cwd: staging })) dirs.push(join(staging, dir))
    dirs.sort((a, b) => b.length - a.length)
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
}

/** Copy the runtime-only packages into the payload with their own node_modules omitted. */
async function copyRuntimeOnlyPackages(staging: string, cli: DeployCli): Promise<void> {
  for (const [name, sourceDir] of Object.entries(RUNTIME_ONLY_PACKAGES)) {
    if (cli.dryRun) {
      console.log(`deploy-dsh-runtime: [dry-run] copy ${sourceDir} -> node_modules/${name}`)
      continue
    }
    const origin = resolve(root, sourceDir)
    const manifest = JSON.parse(await readFile(join(origin, 'package.json'), 'utf8')) as { name?: string }
    if (manifest.name !== name) {
      throw new Error(`deploy-dsh-runtime: ${origin} is ${manifest.name ?? 'unnamed'}, expected ${name}`)
    }
    const destination = join(staging, 'node_modules', ...name.split('/'))
    if (existsSync(destination)) continue
    const nestedNodeModules = join(origin, 'node_modules')
    await mkdir(dirname(destination), { recursive: true })
    await cp(origin, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    console.log(`deploy-dsh-runtime: copied runtime-only package ${name}`)
  }
}

/** Assert the payload carries everything the runtime needs to boot. */
async function assertRuntime(staging: string, cli: DeployCli): Promise<void> {
  if (cli.dryRun) {
    console.log('deploy-dsh-runtime: [dry-run] skip payload assertions')
    return
  }
  const required = [
    join(staging, 'lib/bin.js'),
    join(staging, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'),
    join(staging, 'node_modules/@deepseek-ai/dsh-official-bundles/package.json'),
    join(staging, 'node_modules', `@deepseek-ai/node-addon-system-${PLATFORM}`, 'bin', 'landlock-run'),
    join(staging, 'node_modules/@deepseek-ai/dsh-experimental-ptc-runtime-python/py/bootstrap.py'),
    join(staging, 'node_modules', `@vscode/ripgrep-${PLATFORM}`, 'bin', 'rg'),
    join(staging, 'LICENSE'),
    join(staging, 'THIRD_PARTY_NOTICES.md'),
    ...Object.entries(RUNTIME_ONLY_PACKAGES).map(([name]) => join(staging, 'node_modules', ...name.split('/'), 'lib', 'index.js')),
  ]
  const missing = required.filter(file => !existsSync(file))
  if (missing.length > 0) {
    throw new Error(`deploy-dsh-runtime: required runtime artifact missing: ${missing.join(', ')}`)
  }
  let ptyCount = 0
  for await (const _ of glob('node_modules/node-pty/**/*.node', { cwd: staging })) {
    ptyCount++
  }
  if (ptyCount === 0) {
    throw new Error('deploy-dsh-runtime: node-pty compiled addon missing')
  }
}

async function main(): Promise<void> {
  const cli = parseDeployCli(process.argv.slice(2))
  const staging = cli.out
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  await runPnpm('deploy', [
    '--filter', DEPLOY_ROOT_PACKAGE, 'deploy',
    '--legacy',
    '--prod',
    // Production deployment omits workspace tooling such as Electron's patched signer.
    '--config.allow-unused-patches=true',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    '--config.hoist-workspace-packages=false',
    staging,
  ], cli)

  if (cli.restoreDev) {
    // The legacy deploy relinks the virtual store in a production-only layout and drops
    // development links; pnpm's up-to-date check does not detect that state, so the
    // virtual store is rebuilt from the content-addressable store before the install.
    rmSync(join(root, 'node_modules', '.pnpm'), { recursive: true, force: true })
    await runPnpm('restore development dependencies', [
      'install', '--offline', '--frozen-lockfile', '--prod=false', '--ignore-scripts',
    ], cli)
  }

  const restored = await restoreLegacyHoists(staging, resolve(root, DEPLOY_SOURCE_NODE_MODULES))
  if (restored.length > 0) console.log(`deploy-dsh-runtime: restored legacy hoists: ${restored.join(', ')}`)

  await materializeStagedLinks(staging)
  await deduplicateStagedWorkspacePackages(staging, root)

  await copyRuntimeOnlyPackages(staging, cli)

  // The payload must carry the project license and third-party notices.
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const source = join(root, name)
    if (!existsSync(source)) throw new Error(`deploy-dsh-runtime: missing ${source}`)
    await cp(source, join(staging, name))
  }

  await stripRuntimeDocs(staging, cli)
  await assertRuntime(staging, cli)

  if (cli.dryRun) {
    console.log('deploy-dsh-runtime: [dry-run] payload validated')
    return
  }
  console.log('deploy-dsh-runtime: payload validated')
  await new Promise<void>((resolvePromise) => {
    const du = spawn('du', ['-sh', staging], { stdio: 'inherit' })
    du.on('exit', () => { resolvePromise() })
  })
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
