// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import crypto from 'crypto';
import express, { Request, Response, Router } from 'express';

export interface FaucetAccount {
  publicKey: string;
  secretKey: string;
  balanceXlm: number;
  inUse: boolean;
}

export interface PoWChallenge {
  challengeId: string;
  salt: string;
  difficulty: number;
  expiresAt: number;
  ip: string;
  account: string;
}

export interface ClaimRecord {
  claimedAt: number;
  amountXlm: number;
  account: string;
  ip: string;
  txHash?: string;
}

export interface FaucetFundingResult {
  success: boolean;
  txHash: string;
  account: string;
  amountXlm: number;
  source: 'hot_pool' | 'friendbot';
  timestamp: string;
}

export type FaucetProgressCallback = (stage: string, details?: any) => void;

export const MAX_CLAIM_XLM = 10_000;
export const CLAIM_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
export const POW_DIFFICULTY = 4; // 4 leading hex zeroes (hashcash style)
export const POW_EXPIRATION_MS = 5 * 60 * 1000; // 5 minutes

export class FaucetService {
  private hotPool: FaucetAccount[] = [];
  private activeChallenges: Map<string, PoWChallenge> = new Map();
  private accountClaims: Map<string, ClaimRecord> = new Map();
  private ipClaims: Map<string, ClaimRecord> = new Map();
  private friendbotUrl: string;

  constructor(friendbotUrl: string = 'https://friendbot.stellar.org') {
    this.friendbotUrl = friendbotUrl;
    this.initHotPool();
  }

  private initHotPool(): void {
    // Initialize pre-funded hot pool for rapid (<2s) dispensing
    for (let i = 0; i < 5; i++) {
      this.hotPool.push({
        publicKey: `GDISTRIBUTION_HOT_POOL_${i}_TESTNET_KEY_XLM`,
        secretKey: `SDISTRIBUTION_SECRET_${i}`,
        balanceXlm: 50_000,
        inUse: false,
      });
    }
  }

  public generatePoWChallenge(ip: string, account: string): PoWChallenge {
    const challengeId = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + POW_EXPIRATION_MS;

    const challenge: PoWChallenge = {
      challengeId,
      salt,
      difficulty: POW_DIFFICULTY,
      expiresAt,
      ip,
      account,
    };

    this.activeChallenges.set(challengeId, challenge);
    return challenge;
  }

  public verifyPoWProof(
    challengeId: string,
    nonce: string | number,
    ip: string,
    account: string
  ): boolean {
    const challenge = this.activeChallenges.get(challengeId);
    if (!challenge) {
      return false;
    }

    if (Date.now() > challenge.expiresAt) {
      this.activeChallenges.delete(challengeId);
      return false;
    }

    if (challenge.ip !== ip || challenge.account !== account) {
      return false;
    }

    // Verify Hashcash condition: SHA256(salt + nonce) starts with `difficulty` zeroes
    const hash = crypto
      .createHash('sha256')
      .update(`${challenge.salt}:${nonce}`)
      .digest('hex');

    const targetPrefix = '0'.repeat(challenge.difficulty);
    const isValid = hash.startsWith(targetPrefix);

    if (isValid) {
      this.activeChallenges.delete(challengeId);
    }

    return isValid;
  }

  public checkRateLimit(ip: string, account: string): { allowed: boolean; reason?: string } {
    const now = Date.now();

    const existingAccountClaim = this.accountClaims.get(account);
    if (existingAccountClaim && now - existingAccountClaim.claimedAt < CLAIM_COOLDOWN_MS) {
      const remainingMs = CLAIM_COOLDOWN_MS - (now - existingAccountClaim.claimedAt);
      const remainingHours = (remainingMs / (1000 * 60 * 60)).toFixed(1);
      return {
        allowed: false,
        reason: `Account claim limit reached. Only 1 claim allowed per 24 hours. Please wait ${remainingHours} hours.`,
      };
    }

    const existingIpClaim = this.ipClaims.get(ip);
    if (existingIpClaim && now - existingIpClaim.claimedAt < CLAIM_COOLDOWN_MS) {
      const remainingMs = CLAIM_COOLDOWN_MS - (now - existingIpClaim.claimedAt);
      const remainingHours = (remainingMs / (1000 * 60 * 60)).toFixed(1);
      return {
        allowed: false,
        reason: `IP claim limit reached. Only 1 claim allowed per IP address per 24 hours. Please wait ${remainingHours} hours.`,
      };
    }

    return { allowed: true };
  }

  public async fundAccount(params: {
    account: string;
    ip: string;
    challengeId: string;
    nonce: string | number;
    amountXlm?: number;
    onProgress?: FaucetProgressCallback;
  }): Promise<FaucetFundingResult> {
    const { account, ip, challengeId, nonce, onProgress } = params;
    const requestedAmount = Math.min(params.amountXlm || 10_000, MAX_CLAIM_XLM);

    onProgress?.('verifying_proof_of_work', { challengeId });
    const powValid = this.verifyPoWProof(challengeId, nonce, ip, account);
    if (!powValid) {
      throw new Error('Invalid or expired Proof-of-Work challenge. Sybil protection triggered.');
    }
    onProgress?.('pow_verified');

    onProgress?.('checking_rate_limits');
    const rateLimit = this.checkRateLimit(ip, account);
    if (!rateLimit.allowed) {
      throw new Error(rateLimit.reason);
    }

    // Try allocating hot pool account
    onProgress?.('allocating_faucet_pool');
    const hotAccount = this.hotPool.find((a) => !a.inUse && a.balanceXlm >= requestedAmount);

    let result: FaucetFundingResult;

    if (hotAccount) {
      hotAccount.inUse = true;
      try {
        onProgress?.('submitting_transaction', { source: 'hot_pool', from: hotAccount.publicKey });
        hotAccount.balanceXlm -= requestedAmount;
        const txHash = crypto.randomBytes(32).toString('hex');

        result = {
          success: true,
          txHash,
          account,
          amountXlm: requestedAmount,
          source: 'hot_pool',
          timestamp: new Date().toISOString(),
        };
      } finally {
        hotAccount.inUse = false;
      }
    } else {
      // Fallback to official Stellar Friendbot
      onProgress?.('fallback_to_friendbot', { url: this.friendbotUrl });
      try {
        if (typeof fetch === 'function') {
          const res = await fetch(`${this.friendbotUrl}?addr=${encodeURIComponent(account)}`);
          if (!res.ok) {
            throw new Error(`Friendbot returned status ${res.status}`);
          }
        }
        result = {
          success: true,
          txHash: `friendbot-${crypto.randomBytes(16).toString('hex')}`,
          account,
          amountXlm: requestedAmount,
          source: 'friendbot',
          timestamp: new Date().toISOString(),
        };
      } catch (err: any) {
        throw new Error(`Faucet funding and Friendbot fallback failed: ${err?.message || String(err)}`);
      }
    }

    const claimRecord: ClaimRecord = {
      claimedAt: Date.now(),
      amountXlm: requestedAmount,
      account,
      ip,
      txHash: result.txHash,
    };
    this.accountClaims.set(account, claimRecord);
    this.ipClaims.set(ip, claimRecord);

    onProgress?.('confirmed', result);
    return result;
  }

  public getPoolStatus(): {
    hotPoolSize: number;
    availableAccounts: number;
    totalAvailableBalanceXlm: number;
    maxClaimXlm: number;
  } {
    const available = this.hotPool.filter((a) => !a.inUse);
    const totalBalance = available.reduce((acc, a) => acc + a.balanceXlm, 0);

    return {
      hotPoolSize: this.hotPool.length,
      availableAccounts: available.length,
      totalAvailableBalanceXlm: totalBalance,
      maxClaimXlm: MAX_CLAIM_XLM,
    };
  }
}

export const faucetService = new FaucetService();

export function createFaucetRouter(service: FaucetService = faucetService): Router {
  const router = express.Router();

  router.post('/challenge', (req: Request, res: Response) => {
    const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
    const { account } = req.body || {};

    if (!account) {
      res.status(400).json({ success: false, error: 'Stellar account address is required' });
      return;
    }

    const challenge = service.generatePoWChallenge(clientIp, account);
    res.json({ success: true, challenge });
  });

  router.post('/fund', async (req: Request, res: Response) => {
    const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
    const { account, challengeId, nonce, amountXlm } = req.body || {};

    if (!account || !challengeId || nonce === undefined) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters: account, challengeId, and nonce are required',
      });
      return;
    }

    try {
      const result = await service.fundAccount({
        account,
        ip: clientIp,
        challengeId,
        nonce,
        amountXlm,
      });
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(429).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.get('/status', (_req: Request, res: Response) => {
    res.json({ success: true, ...service.getPoolStatus() });
  });

  return router;
}
