// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import express, { Request, Response, Router } from 'express';
import { Queue } from 'bullmq';
import { alertManager } from '../utils/alerting.js';
import {
  createBullQueue,
  getDlqQueueName,
  replayDlqJobs,
} from '../services/bullmqDlqService.js';

export interface DLQJobRecord {
  id: string;
  queue: string;
  jobId: string;
  jobName: string;
  errorType: string;
  errorMessage: string;
  stackTrace: string[];
  inputParameters: Record<string, unknown>;
  retryAttempts: number;
  maxAttempts: number;
  failedAt: string;
  payload?: unknown;
}

export interface DLQFilterOptions {
  queue?: string;
  errorType?: string;
  startDate?: string | Date;
  endDate?: string | Date;
  limit?: number;
  offset?: number;
}

export interface DLQReplayResult {
  queue: string;
  replayedCount: number;
  replayedIds: string[];
  failedCount: number;
  errors: Array<{ jobId: string; error: string }>;
}

export interface DLQMetrics {
  totalFailed: number;
  byQueue: Record<string, number>;
  byErrorType: Record<string, number>;
  depthAlertTriggered: boolean;
  alertThreshold: number;
}

export const DLQ_ALERT_THRESHOLD = 50;

export class DlqInspector {
  private persistentRecords: Map<string, DLQJobRecord> = new Map();
  private managedQueues: Map<string, { primary: Queue; dlq: Queue }> = new Map();
  private alertThreshold: number;

  constructor(alertThreshold: number = DLQ_ALERT_THRESHOLD) {
    this.alertThreshold = alertThreshold;
  }

  public registerQueue(queueName: string, primaryQueue?: Queue, dlqQueue?: Queue): void {
    const primary = primaryQueue || createBullQueue(queueName).queue;
    const dlq = dlqQueue || createBullQueue(getDlqQueueName(queueName)).queue;
    this.managedQueues.set(queueName, { primary, dlq });
  }

  public async captureFailedJob(
    queueName: string,
    job: any,
    error: Error | any
  ): Promise<DLQJobRecord> {
    const jobId = String(job?.id || `job-${Date.now()}`);
    const errorType = error?.name || error?.constructor?.name || 'Error';
    const errorMessage = error?.message || String(error || 'Unknown failure');
    const stackTrace = error?.stack
      ? error.stack.split('\n').map((line: string) => line.trim())
      : Array.isArray(job?.stacktrace)
      ? job.stacktrace
      : [];

    const record: DLQJobRecord = {
      id: `${queueName}:${jobId}`,
      queue: queueName,
      jobId,
      jobName: job?.name || 'unknown-job',
      errorType,
      errorMessage,
      stackTrace,
      inputParameters: job?.data || {},
      retryAttempts: Number(job?.attemptsMade || 0),
      maxAttempts: Number(job?.opts?.attempts || 1),
      failedAt: new Date().toISOString(),
      payload: job?.data,
    };

    this.persistentRecords.set(record.id, record);

    const queuePair = this.managedQueues.get(queueName);
    if (queuePair?.dlq) {
      try {
        await queuePair.dlq.add(record.jobName, record, {
          jobId: record.id,
          removeOnComplete: false,
          removeOnFail: false,
        });
      } catch {
        // Fallback to internal persistent records if Redis is unavailable
      }
    }

    await this.checkDepthAlert(queueName);
    return record;
  }

  public async getQueueDepth(queueName: string): Promise<number> {
    const queuePair = this.managedQueues.get(queueName);
    if (queuePair?.dlq) {
      try {
        const counts = await queuePair.dlq.getJobCounts('waiting', 'delayed', 'failed', 'paused');
        return Object.values(counts).reduce((acc: number, val: number) => acc + val, 0);
      } catch {
        // Fallback to in-memory records
      }
    }

    let count = 0;
    for (const record of this.persistentRecords.values()) {
      if (record.queue === queueName) {
        count += 1;
      }
    }
    return count;
  }

  public async checkDepthAlert(queueName: string): Promise<boolean> {
    const depth = await this.getQueueDepth(queueName);
    if (depth > this.alertThreshold) {
      if (alertManager && typeof alertManager.alert === 'function') {
        alertManager.alert('dlq_depth_exceeded', {
          queue: queueName,
          depth,
          threshold: this.alertThreshold,
          timestamp: new Date().toISOString(),
        });
      }
      return true;
    }
    return false;
  }

  public filterFailedJobs(options: DLQFilterOptions = {}): {
    total: number;
    jobs: DLQJobRecord[];
  } {
    let results = Array.from(this.persistentRecords.values());

    if (options.queue) {
      results = results.filter((r) => r.queue === options.queue);
    }

    if (options.errorType) {
      const targetType = options.errorType.toLowerCase();
      results = results.filter((r) => r.errorType.toLowerCase().includes(targetType));
    }

    if (options.startDate) {
      const startMs = new Date(options.startDate).getTime();
      results = results.filter((r) => new Date(r.failedAt).getTime() >= startMs);
    }

    if (options.endDate) {
      const endMs = new Date(options.endDate).getTime();
      results = results.filter((r) => new Date(r.failedAt).getTime() <= endMs);
    }

    results.sort((a, b) => new Date(b.failedAt).getTime() - new Date(a.failedAt).getTime());

    const total = results.length;
    const offset = Math.max(0, options.offset || 0);
    const limit = options.limit ? Math.max(1, options.limit) : 50;
    const paged = results.slice(offset, offset + limit);

    return { total, jobs: paged };
  }

  public async bulkReplay(
    queueName: string,
    jobIds?: string[],
    limit: number = 100
  ): Promise<DLQReplayResult> {
    const result: DLQReplayResult = {
      queue: queueName,
      replayedCount: 0,
      replayedIds: [],
      failedCount: 0,
      errors: [],
    };

    const queuePair = this.managedQueues.get(queueName);
    const targetRecords: DLQJobRecord[] = [];

    if (jobIds && jobIds.length > 0) {
      for (const id of jobIds) {
        const fullId = id.includes(':') ? id : `${queueName}:${id}`;
        const record = this.persistentRecords.get(fullId);
        if (record) targetRecords.push(record);
      }
    } else {
      const matching = this.filterFailedJobs({ queue: queueName, limit });
      targetRecords.push(...matching.jobs);
    }

    if (queuePair?.primary && queuePair?.dlq) {
      try {
        const replayed = await replayDlqJobs({
          sourceQueue: queuePair.primary,
          dlqQueue: queuePair.dlq,
          limit: targetRecords.length || limit,
          removeAfterReplay: true,
        });

        for (const item of replayed) {
          result.replayedCount += 1;
          result.replayedIds.push(item.dlqJobId);
          this.persistentRecords.delete(item.dlqJobId);
        }
      } catch (err: any) {
        result.errors.push({ jobId: 'bulk', error: err?.message || String(err) });
      }
    } else {
      for (const record of targetRecords) {
        try {
          result.replayedCount += 1;
          result.replayedIds.push(record.id);
          this.persistentRecords.delete(record.id);
        } catch (err: any) {
          result.failedCount += 1;
          result.errors.push({ jobId: record.id, error: err?.message || String(err) });
        }
      }
    }

    return result;
  }

  public async getMetrics(): Promise<DLQMetrics> {
    const records = Array.from(this.persistentRecords.values());
    const byQueue: Record<string, number> = {};
    const byErrorType: Record<string, number> = {};

    let depthAlertTriggered = false;

    for (const record of records) {
      byQueue[record.queue] = (byQueue[record.queue] || 0) + 1;
      byErrorType[record.errorType] = (byErrorType[record.errorType] || 0) + 1;
    }

    for (const queueName of Object.keys(byQueue)) {
      if (byQueue[queueName] > this.alertThreshold) {
        depthAlertTriggered = true;
      }
    }

    return {
      totalFailed: records.length,
      byQueue,
      byErrorType,
      depthAlertTriggered,
      alertThreshold: this.alertThreshold,
    };
  }

  public renderDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DLQ Inspector & Retry Management Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 2rem; background: #0f172a; color: #f8fafc; }
    h1 { color: #38bdf8; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; border: 1px solid #334155; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid #334155; }
    th { color: #94a3b8; font-size: 0.875rem; text-transform: uppercase; }
    .badge { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; background: #ef4444; color: white; }
    button { background: #0284c7; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; }
    button:hover { background: #0369a1; }
  </style>
</head>
<body>
  <h1>Dead-Letter Queue (DLQ) Inspector</h1>
  <div class="card">
    <h2>Queue Inspection & Management</h2>
    <p>Threshold for automated alerts: > ${this.alertThreshold} failed items</p>
    <div id="status">Active Queues: compilations, webhooks, transaction submissions</div>
  </div>
</body>
</html>`;
  }
}

export const dlqInspector = new DlqInspector();

export function createDlqInspectorRouter(inspector: DlqInspector = dlqInspector): Router {
  const router = express.Router();

  router.get('/dashboard', (_req: Request, res: Response) => {
    res.type('html').send(inspector.renderDashboardHtml());
  });

  router.get('/failed-jobs', (req: Request, res: Response) => {
    const { queue, errorType, startDate, endDate, limit, offset } = req.query;
    const filterOptions: DLQFilterOptions = {
      queue: queue ? String(queue) : undefined,
      errorType: errorType ? String(errorType) : undefined,
      startDate: startDate ? String(startDate) : undefined,
      endDate: endDate ? String(endDate) : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    };

    const data = inspector.filterFailedJobs(filterOptions);
    res.json({ success: true, ...data });
  });

  router.get('/metrics', async (_req: Request, res: Response) => {
    const metrics = await inspector.getMetrics();
    res.json({ success: true, metrics });
  });

  router.post('/replay', async (req: Request, res: Response) => {
    const { queue, jobIds, limit } = req.body || {};
    if (!queue) {
      res.status(400).json({ success: false, error: 'Queue name is required' });
      return;
    }

    const result = await inspector.bulkReplay(queue, jobIds, limit);
    res.json({ success: true, result });
  });

  return router;
}
