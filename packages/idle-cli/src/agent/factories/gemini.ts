/**
 * Gemini ACP Backend - Gemini CLI agent via ACP
 *
 * This module provides a factory function for creating a Gemini backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * Gemini CLI is a reference ACP implementation from Google that supports
 * the --experimental-acp flag for ACP mode.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { geminiTransport } from '../transport';
import { logger } from '@/ui/logger';
import type { SandboxConfig } from '@/persistence';
import {
  GEMINI_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  GEMINI_MODEL_ENV,
  DEFAULT_GEMINI_MODEL
} from '@/gemini/constants';
import {
  readGeminiLocalConfig,
  determineGeminiModel,
  getGeminiModelSource
} from '@/gemini/utils/config';

/**
 * Options for creating a Gemini ACP backend
 */
export interface GeminiBackendOptions extends AgentFactoryOptions {
  /** API key for Gemini (defaults to GEMINI_API_KEY or GOOGLE_API_KEY env var) */
  apiKey?: string;

  /** Model to use. If undefined, will use local config, env var, or default.
   *  If explicitly set to null, will use default (skip local config).
   *  (defaults to GEMINI_MODEL env var or 'gemini-2.5-pro') */
  model?: string | null;

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;

  /** Required OS sandbox policy for the Gemini child process. */
  sandboxConfig?: SandboxConfig;

  /** Reports observed runtime enforcement for session metadata. */
  onSandboxApplied?: (applied: boolean) => void;
}

/**
 * Result of creating a Gemini backend
 */
export interface GeminiBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used (single source of truth) */
  model: string;
  /** Source of the model selection for logging */
  modelSource: 'explicit' | 'env-var' | 'local-config' | 'default';
}

/**
 * Create a Gemini backend using ACP (official SDK).
 *
 * The Gemini CLI must be installed and available in PATH.
 * Uses the --experimental-acp flag to enable ACP mode.
 *
 * @param options - Configuration options
 * @returns GeminiBackendResult with backend and resolved model (single source of truth)
 */
export function createGeminiBackend(options: GeminiBackendOptions): GeminiBackendResult {

  // Resolve API key from multiple sources (in priority order):
  // Idle never reads or uploads Gemini CLI OAuth credentials. The official
  // Gemini process handles its own local sign-in. API keys may be passed via
  // the documented environment variables.

  // Try reading from local Gemini CLI config (token and model)
  const localConfig = readGeminiLocalConfig();

  const apiKey = process.env[GEMINI_API_KEY_ENV]
    || process.env[GOOGLE_API_KEY_ENV]
    || options.apiKey;

  if (!apiKey) {
    logger.debug(`[Gemini] No API key override found; the official Gemini CLI will use its local authentication.`);
  }

  // Command to run gemini
  const geminiCommand = 'gemini';

  // Get model from options, local config, system environment, or use default
  // Priority: options.model (if provided) > local config > env var > default
  // If options.model is undefined, check local config, then env, then use default
  // If options.model is explicitly null, skip local config and use env/default
  const model = determineGeminiModel(options.model, localConfig);

  // Build args - use only --experimental-acp flag
  // Model is passed via GEMINI_MODEL env var (gemini CLI reads it automatically)
  // We don't use --model flag to avoid potential stdout conflicts with ACP protocol
  const geminiArgs = ['--experimental-acp'];

  // Get Google Cloud Project from local config (for Workspace accounts)
  // Only use if: no email stored (global), or email matches current user
  let googleCloudProject: string | null = null;
  if (localConfig.googleCloudProject) {
    const storedEmail = localConfig.googleCloudProjectEmail;
    // Per-account projects from older builds are not applied without a local
    // identity signal. Re-save the project to make it global if desired.
    if (!storedEmail) {
      googleCloudProject = localConfig.googleCloudProject;
      logger.debug('[Gemini] Using a configured global Google Cloud project');
    } else {
      logger.debug('[Gemini] Skipping a legacy account-specific Google Cloud project');
    }
  }

  const backendOptions: AcpBackendOptions = {
    agentName: 'gemini',
    cwd: options.cwd,
    command: geminiCommand,
    args: geminiArgs,
    env: {
      ...options.env,
      ...(apiKey ? { [GEMINI_API_KEY_ENV]: apiKey, [GOOGLE_API_KEY_ENV]: apiKey } : {}),
      // Pass model via env var - gemini CLI reads GEMINI_MODEL automatically
      [GEMINI_MODEL_ENV]: model,
      // Pass Google Cloud Project for Workspace accounts
      ...(googleCloudProject ? {
        GOOGLE_CLOUD_PROJECT: googleCloudProject,
        GOOGLE_CLOUD_PROJECT_ID: googleCloudProject,
      } : {}),
      // Suppress debug output from gemini CLI to avoid stdout pollution
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: geminiTransport,
    // Check if prompt instructs the agent to change title (for auto-approval of change_title tool)
    hasChangeTitleInstruction: (prompt: string) => {
      const lower = prompt.toLowerCase();
      return lower.includes('change_title') ||
             lower.includes('change title') ||
             lower.includes('set title') ||
             lower.includes('mcp__idle__change_title');
    },
    sandboxConfig: options.sandboxConfig,
    onSandboxApplied: options.onSandboxApplied,
  };

  // Determine model source for logging
  const modelSource = getGeminiModelSource(options.model, localConfig);

  logger.debug('[Gemini] Creating ACP SDK backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    hasApiKey: !!apiKey,
    model: model,
    modelSource: modelSource,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return {
    backend: new AcpBackend(backendOptions),
    model,
    modelSource,
  };
}

/**
 * Register Gemini backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the Gemini agent available for use.
 */
export function registerGeminiAgent(): void {
  agentRegistry.register('gemini', (opts) => createGeminiBackend(opts).backend);
  logger.debug('[Gemini] Registered with agent registry');
}
