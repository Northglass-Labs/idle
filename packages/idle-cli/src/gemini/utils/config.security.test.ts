import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { determineGeminiModel, readGeminiLocalConfig } from './config';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs', () => fsMocks);
vi.mock('os', () => ({ homedir: () => '/tmp/idle-gemini-config-test' }));
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('Gemini config log privacy', () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnvironment };
    delete process.env.GEMINI_MODEL;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    fsMocks.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it('preserves environment selections without persisting model or project identifiers', () => {
    const opaqueModel = 'OPAQUE_GEMINI_MODEL_7ba1';
    const opaqueProject = 'OPAQUE_GCP_PROJECT_15f0';
    process.env.GEMINI_MODEL = opaqueModel;
    process.env.GOOGLE_CLOUD_PROJECT = opaqueProject;

    expect(determineGeminiModel(undefined, {
      model: 'OPAQUE_LOCAL_MODEL_1f27',
      googleCloudProject: null,
      googleCloudProjectEmail: null,
    })).toBe(opaqueModel);
    expect(readGeminiLocalConfig()).toEqual({
      model: null,
      googleCloudProject: opaqueProject,
      googleCloudProjectEmail: null,
    });

    const debugOutput = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(debugOutput).not.toContain(opaqueModel);
    expect(debugOutput).not.toContain(opaqueProject);
    expect(debugOutput).not.toContain('OPAQUE_LOCAL_MODEL_1f27');
  });

  it('keeps config parse error messages out of logger calls', () => {
    const opaqueError = 'OPAQUE_GEMINI_CONFIG_ERROR_0f93';
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockImplementation(() => {
      throw new Error(opaqueError);
    });

    expect(readGeminiLocalConfig()).toEqual({
      model: null,
      googleCloudProject: null,
      googleCloudProjectEmail: null,
    });

    const debugOutput = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(debugOutput).not.toContain(opaqueError);
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      '[Gemini] Failed to read config',
      { errorType: 'error' },
    );
  });
});
