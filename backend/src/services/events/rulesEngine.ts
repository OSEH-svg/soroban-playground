// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import express, { Request, Response, Router } from 'express';

export type ComparisonOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'regex';

export type NotificationType = 'webhook' | 'slack' | 'telegram' | 'email';

export interface NotificationTarget {
  type: NotificationType;
  endpoint?: string;
  url?: string;
  channel?: string;
  recipient?: string;
  headers?: Record<string, string>;
}

export interface SimpleCondition {
  field: string;
  operator: ComparisonOperator;
  value: any;
}

export interface CompositeCondition {
  and?: (SimpleCondition | CompositeCondition)[];
  or?: (SimpleCondition | CompositeCondition)[];
  not?: SimpleCondition | CompositeCondition;
}

export type RuleCondition = SimpleCondition | CompositeCondition;

export interface EventRule {
  id: string;
  name: string;
  contractId?: string;
  topic?: string;
  condition: RuleCondition;
  targets: NotificationTarget[];
  enabled: boolean;
}

export interface ContractEvent {
  contractId: string;
  topics: (string | number)[];
  payload: Record<string, any>;
  timestamp?: number | string;
}

export interface RuleEvaluationResult {
  ruleId: string;
  matched: boolean;
  routedTargets: NotificationTarget[];
  evaluationTimeMs: number;
}

export class RulesEngine {
  private rules: Map<string, EventRule> = new Map();
  private rulesByContract: Map<string, Set<string>> = new Map();

  public validateRule(rule: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!rule || typeof rule !== 'object') {
      return { valid: false, errors: ['Rule must be an object'] };
    }

    if (!rule.id || typeof rule.id !== 'string') {
      errors.push('Rule "id" is required and must be a string');
    }

    if (!rule.name || typeof rule.name !== 'string') {
      errors.push('Rule "name" is required and must be a string');
    }

    if (!rule.condition || typeof rule.condition !== 'object') {
      errors.push('Rule "condition" is required and must be an object');
    } else {
      this.validateCondition(rule.condition, errors, 'condition');
    }

    if (!Array.isArray(rule.targets) || rule.targets.length === 0) {
      errors.push('Rule "targets" must be a non-empty array');
    } else {
      rule.targets.forEach((target: any, idx: number) => {
        const validTypes: NotificationType[] = ['webhook', 'slack', 'telegram', 'email'];
        if (!target || !validTypes.includes(target.type)) {
          errors.push(`Target at index ${idx} must have valid type: ${validTypes.join(', ')}`);
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  private validateCondition(condition: any, errors: string[], path: string): void {
    if (!condition || typeof condition !== 'object') {
      errors.push(`${path}: Condition must be an object`);
      return;
    }

    const hasAnd = 'and' in condition;
    const hasOr = 'or' in condition;
    const hasNot = 'not' in condition;
    const hasField = 'field' in condition;

    if (!hasAnd && !hasOr && !hasNot && !hasField) {
      errors.push(`${path}: Condition must specify "field", "and", "or", or "not"`);
      return;
    }

    if (hasField) {
      const validOps: ComparisonOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'regex'];
      if (typeof condition.field !== 'string') {
        errors.push(`${path}.field must be a string`);
      }
      if (!validOps.includes(condition.operator)) {
        errors.push(`${path}.operator must be one of: ${validOps.join(', ')}`);
      }
      if (condition.value === undefined) {
        errors.push(`${path}.value is required`);
      }
      if (condition.operator === 'regex') {
        try {
          new RegExp(condition.value);
        } catch {
          errors.push(`${path}.value must be a valid regular expression`);
        }
      }
      if (condition.operator === 'in' && !Array.isArray(condition.value)) {
        errors.push(`${path}.value must be an array for "in" operator`);
      }
    }

    if (hasAnd) {
      if (!Array.isArray(condition.and)) {
        errors.push(`${path}.and must be an array`);
      } else {
        condition.and.forEach((item: any, i: number) => {
          this.validateCondition(item, errors, `${path}.and[${i}]`);
        });
      }
    }

    if (hasOr) {
      if (!Array.isArray(condition.or)) {
        errors.push(`${path}.or must be an array`);
      } else {
        condition.or.forEach((item: any, i: number) => {
          this.validateCondition(item, errors, `${path}.or[${i}]`);
        });
      }
    }

    if (hasNot) {
      this.validateCondition(condition.not, errors, `${path}.not`);
    }
  }

  public addRule(rule: EventRule): void {
    const validation = this.validateRule(rule);
    if (!validation.valid) {
      throw new Error(`Invalid rule definition: ${validation.errors.join('; ')}`);
    }

    this.rules.set(rule.id, rule);

    if (rule.contractId) {
      if (!this.rulesByContract.has(rule.contractId)) {
        this.rulesByContract.set(rule.contractId, new Set());
      }
      this.rulesByContract.get(rule.contractId)!.add(rule.id);
    }
  }

  public removeRule(ruleId: string): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;

    if (rule.contractId && this.rulesByContract.has(rule.contractId)) {
      this.rulesByContract.get(rule.contractId)!.delete(ruleId);
    }
    return this.rules.delete(ruleId);
  }

  public evaluateEvent(event: ContractEvent): RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    const candidateRules = this.getCandidateRules(event);

    for (const rule of candidateRules) {
      if (!rule.enabled) continue;

      const start = performance.now();
      const matched = this.evaluateCondition(rule.condition, event);
      const elapsed = performance.now() - start;

      const result: RuleEvaluationResult = {
        ruleId: rule.id,
        matched,
        routedTargets: matched ? rule.targets : [],
        evaluationTimeMs: elapsed,
      };

      results.push(result);

      if (matched) {
        this.routeEvent(rule, event);
      }
    }

    return results;
  }

  private getCandidateRules(event: ContractEvent): EventRule[] {
    if (event.contractId && this.rulesByContract.has(event.contractId)) {
      const contractRuleIds = this.rulesByContract.get(event.contractId)!;
      const specificRules: EventRule[] = [];
      for (const id of contractRuleIds) {
        const r = this.rules.get(id);
        if (r) specificRules.push(r);
      }
      return specificRules;
    }
    return Array.from(this.rules.values());
  }

  public evaluateCondition(condition: RuleCondition, event: ContractEvent): boolean {
    const composite = condition as CompositeCondition;

    // Short-circuit AND evaluation
    if (composite.and && Array.isArray(composite.and)) {
      for (const sub of composite.and) {
        if (!this.evaluateCondition(sub, event)) {
          return false;
        }
      }
      return true;
    }

    // Short-circuit OR evaluation
    if (composite.or && Array.isArray(composite.or)) {
      for (const sub of composite.or) {
        if (this.evaluateCondition(sub, event)) {
          return true;
        }
      }
      return false;
    }

    // NOT evaluation
    if (composite.not) {
      return !this.evaluateCondition(composite.not, event);
    }

    // Simple condition evaluation
    const simple = condition as SimpleCondition;
    const resolvedValue = this.extractField(simple.field, event);
    return this.compare(simple.operator, resolvedValue, simple.value);
  }

  private extractField(fieldPath: string, event: ContractEvent): any {
    if (fieldPath === 'contractId') return event.contractId;
    if (fieldPath.startsWith('topics.')) {
      const index = parseInt(fieldPath.replace('topics.', ''), 10);
      return event.topics?.[index];
    }
    if (fieldPath.startsWith('payload.')) {
      const parts = fieldPath.replace('payload.', '').split('.');
      let current: any = event.payload;
      for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        current = current[part];
      }
      return current;
    }
    return event.payload?.[fieldPath];
  }

  public compare(operator: ComparisonOperator, actual: any, expected: any): boolean {
    if (actual === undefined || actual === null) {
      return operator === 'neq' ? expected !== null && expected !== undefined : false;
    }

    switch (operator) {
      case 'eq':
        return actual === expected || String(actual) === String(expected);
      case 'neq':
        return actual !== expected && String(actual) !== String(expected);
      case 'gt':
        return Number(actual) > Number(expected);
      case 'gte':
        return Number(actual) >= Number(expected);
      case 'lt':
        return Number(actual) < Number(expected);
      case 'lte':
        return Number(actual) <= Number(expected);
      case 'in':
        return Array.isArray(expected) && expected.includes(actual);
      case 'regex':
        try {
          return new RegExp(expected).test(String(actual));
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  public async routeEvent(rule: EventRule, event: ContractEvent): Promise<void> {
    for (const target of rule.targets) {
      try {
        const payload = {
          ruleId: rule.id,
          ruleName: rule.name,
          event,
          dispatchedAt: new Date().toISOString(),
        };

        if (target.type === 'webhook' && (target.url || target.endpoint)) {
          const endpoint = (target.url || target.endpoint)!;
          if (typeof fetch === 'function') {
            await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(target.headers || {}) },
              body: JSON.stringify(payload),
            }).catch(() => {});
          }
        }
      } catch {
        // Safe dispatch fallback
      }
    }
  }

  public benchmark(ruleCount: number = 1000): {
    rulesEvaluated: number;
    totalDurationMs: number;
    averagePerRuleUs: number;
    meetsSub5msTarget: boolean;
  } {
    const testRules: EventRule[] = [];
    for (let i = 0; i < ruleCount; i++) {
      testRules.push({
        id: `bench-rule-${i}`,
        name: `Benchmark Rule ${i}`,
        enabled: true,
        condition: {
          and: [
            { field: 'payload.amount', operator: 'gt', value: 1000 },
            { field: 'payload.asset', operator: 'eq', value: 'USDC' },
          ],
        },
        targets: [{ type: 'webhook', url: 'https://example.com/webhook' }],
      });
    }

    const testEvent: ContractEvent = {
      contractId: 'C123BENCHMARK',
      topics: ['Transfer', '0x123', '0x456'],
      payload: { amount: 2500, asset: 'USDC', sender: 'test-user' },
    };

    const start = performance.now();
    for (const rule of testRules) {
      this.evaluateCondition(rule.condition, testEvent);
    }
    const totalDurationMs = performance.now() - start;

    return {
      rulesEvaluated: ruleCount,
      totalDurationMs,
      averagePerRuleUs: (totalDurationMs / ruleCount) * 1000,
      meetsSub5msTarget: totalDurationMs < 5.0,
    };
  }
}

export const rulesEngine = new RulesEngine();

export function createRulesEngineRouter(engine: RulesEngine = rulesEngine): Router {
  const router = express.Router();

  router.post('/evaluate', (req: Request, res: Response) => {
    try {
      const event: ContractEvent = req.body;
      const results = engine.evaluateEvent(event);
      res.json({ success: true, count: results.length, matches: results.filter((r) => r.matched) });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err?.message || String(err) });
    }
  });

  router.post('/rules', (req: Request, res: Response) => {
    const validation = engine.validateRule(req.body);
    if (!validation.valid) {
      res.status(400).json({ success: false, errors: validation.errors });
      return;
    }
    engine.addRule(req.body);
    res.status(201).json({ success: true, ruleId: req.body.id });
  });

  router.get('/benchmark', (req: Request, res: Response) => {
    const count = Number(req.query.count) || 1000;
    const bench = engine.benchmark(count);
    res.json({ success: true, benchmark: bench });
  });

  return router;
}
