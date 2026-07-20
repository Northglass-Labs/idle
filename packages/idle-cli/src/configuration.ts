/**
 * Global configuration for idle CLI
 *
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import packageJson from '../package.json'
import { normalizeServerUrl } from '@northglass/idle-wire'

const MAX_BOOTSTRAP_SETTINGS_BYTES = 1024 * 1024

class Configuration {
  public readonly serverUrl: string
  public readonly webappUrl: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly idleHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly sessionsFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

  constructor() {
    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    // Directory configuration - Priority: IDLE_HOME_DIR env > default home dir
    if (process.env.IDLE_HOME_DIR) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.IDLE_HOME_DIR.replace(/^~/, homedir())
      this.idleHomeDir = resolve(expandedPath)
    } else {
      this.idleHomeDir = join(homedir(), '.idle')
    }
    ensureOwnerOnlyDirectory(this.idleHomeDir, 'Idle data directory')

    this.logsDir = join(this.idleHomeDir, 'logs')
    ensureOwnerOnlyDirectory(this.logsDir, 'Idle logs directory')
    this.settingsFile = join(this.idleHomeDir, 'settings.json')
    this.privateKeyFile = join(this.idleHomeDir, 'access.key')
    this.daemonStateFile = join(this.idleHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.idleHomeDir, 'daemon.state.json.lock')
    this.sessionsFile = join(this.idleHomeDir, 'sessions.json')

    // URL precedence (both): IDLE_*_URL env > settings.<key> > default.
    // Settings are read sync here (avoid circular import with persistence.ts).
    // webappUrl must follow the same chain as serverUrl, otherwise `idle server`
    // self-host points the API at localhost but auth still opens the prod webapp.
    const configuredServerUrl =
      process.env.IDLE_SERVER_URL ||
      readSettingsStringSync(this.settingsFile, 'serverUrl') ||
      'https://idle-api.northglass.io'
    this.serverUrl = normalizeServerUrl(configuredServerUrl)
    this.webappUrl =
      process.env.IDLE_WEBAPP_URL ||
      readSettingsStringSync(this.settingsFile, 'webappUrl') ||
      'https://idle.northglass.io'

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.IDLE_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.IDLE_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    const variant = process.env.IDLE_VARIANT || 'stable'
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - isolated data directory configured')
    }

  }
}

function ensureOwnerOnlyDirectory(directory: string, label: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  const directoryStat = lstatSync(directory)
  if (directoryStat.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symlink`)
  }
  if (!directoryStat.isDirectory()) {
    throw new Error(`${label} must be a directory`)
  }
  if (process.platform === 'win32') {
    return
  }

  let descriptor: number | undefined
  try {
    descriptor = openSync(
      directory,
      constants.O_RDONLY
        | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0),
    )
    const openStat = fstatSync(descriptor)
    if (
      !openStat.isDirectory()
      || directoryStat.dev !== openStat.dev
      || directoryStat.ino !== openStat.ino
    ) {
      throw new Error(`${label} changed during validation`)
    }
    if ((openStat.mode & 0o777) !== 0o700) {
      fchmodSync(descriptor, 0o700)
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}

function readSettingsStringSync(settingsFile: string, key: 'serverUrl' | 'webappUrl'): string | undefined {
  let descriptor: number | undefined
  try {
    const pathStat = lstatSync(settingsFile)
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return undefined

    descriptor = openSync(settingsFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const fileStat = fstatSync(descriptor)
    if (
      !fileStat.isFile()
      || fileStat.size > MAX_BOOTSTRAP_SETTINGS_BYTES
      || pathStat.dev !== fileStat.dev
      || pathStat.ino !== fileStat.ino
    ) {
      return undefined
    }
    if (process.platform !== 'win32' && (fileStat.mode & 0o777) !== 0o600) {
      fchmodSync(descriptor, 0o600)
    }

    const raw = JSON.parse(readFileSync(descriptor, 'utf8'))
    const value = raw?.[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
  }
}

export const configuration: Configuration = new Configuration()
