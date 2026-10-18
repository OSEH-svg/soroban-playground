// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import express, { Request, Response, Router } from 'express';

export type SupportedToolchain = '1.78' | '1.79' | '1.80' | 'nightly';

export interface ToolchainConfig {
  channel: SupportedToolchain;
  version: string;
  containerImage: string;
  targets: string[];
  components: string[];
  prewarmed: boolean;
  msrv: boolean;
  stdCacheAvailable: boolean;
}

export interface ParsedRustToolchain {
  channel: SupportedToolchain;
  targets: string[];
  components: string[];
  profile?: string;
  raw: string;
}

export interface ToolchainSandboxRoute {
  channel: SupportedToolchain;
  containerImage: string;
  targetArchitecture: string;
  cachedStdPath: string;
  env: Record<string, string>;
}

export const SUPPORTED_TOOLCHAINS: Record<SupportedToolchain, ToolchainConfig> = {
  '1.78': {
    channel: '1.78',
    version: '1.78.0',
    containerImage: 'stellar/rust-compiler:1.78-wasm',
    targets: ['wasm32-unknown-unknown'],
    components: ['rust-std', 'rustc', 'cargo'],
    prewarmed: true,
    msrv: true,
    stdCacheAvailable: true,
  },
  '1.79': {
    channel: '1.79',
    version: '1.79.0',
    containerImage: 'stellar/rust-compiler:1.79-wasm',
    targets: ['wasm32-unknown-unknown'],
    components: ['rust-std', 'rustc', 'cargo'],
    prewarmed: true,
    msrv: false,
    stdCacheAvailable: true,
  },
  '1.80': {
    channel: '1.80',
    version: '1.80.0',
    containerImage: 'stellar/rust-compiler:1.80-wasm',
    targets: ['wasm32-unknown-unknown'],
    components: ['rust-std', 'rustc', 'cargo'],
    prewarmed: true,
    msrv: false,
    stdCacheAvailable: true,
  },
  nightly: {
    channel: 'nightly',
    version: 'nightly-2024-08-01',
    containerImage: 'stellar/rust-compiler:nightly-wasm',
    targets: ['wasm32-unknown-unknown'],
    components: ['rust-std', 'rustc', 'cargo', 'rust-src'],
    prewarmed: true,
    msrv: false,
    stdCacheAvailable: true,
  },
};

export const DEFAULT_TOOLCHAIN: SupportedToolchain = '1.80';
export const STANDARD_WASM_TARGET = 'wasm32-unknown-unknown';

const DISALLOWED_FLAGS = [
  '-Z',
  '--cfg',
  '--extern',
  '--sysroot',
  '-C',
  '--codegen',
  '--remap-path-prefix',
  '--out-dir',
];

export class ToolchainManager {
  private cacheDirectory: string;

  constructor(cacheDirectory: string = '/var/cache/soroban-toolchains') {
    this.cacheDirectory = cacheDirectory;
  }

  public parseRustToolchainToml(tomlContent: string): ParsedRustToolchain {
    if (!tomlContent || typeof tomlContent !== 'string') {
      return {
        channel: DEFAULT_TOOLCHAIN,
        targets: [STANDARD_WASM_TARGET],
        components: ['rust-std'],
        raw: '',
      };
    }

    let detectedChannel: string | null = null;
    const detectedTargets: string[] = [];
    const detectedComponents: string[] = [];
    let detectedProfile: string | undefined;

    const lines = tomlContent.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const channelMatch = line.match(/^channel\s*=\s*["']([^"']+)["']/i);
      if (channelMatch) {
        detectedChannel = channelMatch[1].trim();
      }

      const targetsMatch = line.match(/^targets\s*=\s*\[(.*)\]/i);
      if (targetsMatch) {
        const items = targetsMatch[1]
          .split(',')
          .map((s) => s.replace(/["']/g, '').trim())
          .filter(Boolean);
        detectedTargets.push(...items);
      }

      const componentsMatch = line.match(/^components\s*=\s*\[(.*)\]/i);
      if (componentsMatch) {
        const items = componentsMatch[1]
          .split(',')
          .map((s) => s.replace(/["']/g, '').trim())
          .filter(Boolean);
        detectedComponents.push(...items);
      }

      const profileMatch = line.match(/^profile\s*=\s*["']([^"']+)["']/i);
      if (profileMatch) {
        detectedProfile = profileMatch[1].trim();
      }
    }

    let channel: SupportedToolchain = DEFAULT_TOOLCHAIN;
    if (detectedChannel) {
      const normalized = detectedChannel.toLowerCase();
      if (normalized.includes('nightly')) {
        channel = 'nightly';
      } else if (normalized.startsWith('1.78')) {
        channel = '1.78';
      } else if (normalized.startsWith('1.79')) {
        channel = '1.79';
      } else if (normalized.startsWith('1.80')) {
        channel = '1.80';
      } else {
        throw new Error(
          `Unsupported Rust toolchain version: "${detectedChannel}". Supported versions: ${Object.keys(
            SUPPORTED_TOOLCHAINS
          ).join(', ')}`
        );
      }
    }

    if (!detectedTargets.includes(STANDARD_WASM_TARGET)) {
      detectedTargets.push(STANDARD_WASM_TARGET);
    }

    return {
      channel,
      targets: detectedTargets,
      components: detectedComponents,
      profile: detectedProfile,
      raw: tomlContent,
    };
  }

  public validateCompilerFlags(flags: string[] = []): { valid: boolean; rejectedFlag?: string } {
    for (const flag of flags) {
      const trimmed = flag.trim();
      for (const disallowed of DISALLOWED_FLAGS) {
        if (trimmed === disallowed || trimmed.startsWith(`${disallowed}=`)) {
          return { valid: false, rejectedFlag: trimmed };
        }
      }
    }
    return { valid: true };
  }

  public resolveSandboxRoute(
    rustToolchainToml?: string,
    requestedFlags: string[] = []
  ): ToolchainSandboxRoute {
    const flagCheck = this.validateCompilerFlags(requestedFlags);
    if (!flagCheck.valid) {
      throw new Error(`Disallowed compiler flag detected: "${flagCheck.rejectedFlag}"`);
    }

    const parsed = this.parseRustToolchainToml(rustToolchainToml || '');
    const config = SUPPORTED_TOOLCHAINS[parsed.channel];

    const cachedStdPath = `${this.cacheDirectory}/${parsed.channel}/std-${STANDARD_WASM_TARGET}`;

    return {
      channel: parsed.channel,
      containerImage: config.containerImage,
      targetArchitecture: STANDARD_WASM_TARGET,
      cachedStdPath,
      env: {
        RUSTUP_TOOLCHAIN: parsed.channel,
        RUST_TARGET_PATH: cachedStdPath,
        CARGO_BUILD_TARGET: STANDARD_WASM_TARGET,
        RUSTUP_AUTO_DOWNLOAD: 'false',
      },
    };
  }

  public listToolchains(): {
    toolchains: ToolchainConfig[];
    defaultChannel: SupportedToolchain;
    supportedArchitectures: string[];
  } {
    return {
      toolchains: Object.values(SUPPORTED_TOOLCHAINS),
      defaultChannel: DEFAULT_TOOLCHAIN,
      supportedArchitectures: [STANDARD_WASM_TARGET],
    };
  }
}

export const toolchainManager = new ToolchainManager();

export function createToolchainRouter(manager: ToolchainManager = toolchainManager): Router {
  const router = express.Router();

  router.get('/toolchains', (_req: Request, res: Response) => {
    res.json({
      success: true,
      ...manager.listToolchains(),
    });
  });

  router.post('/toolchains/resolve', (req: Request, res: Response) => {
    try {
      const { rustToolchainToml, flags } = req.body || {};
      const route = manager.resolveSandboxRoute(rustToolchainToml, flags);
      res.json({ success: true, route });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err?.message || String(err) });
    }
  });

  return router;
}
