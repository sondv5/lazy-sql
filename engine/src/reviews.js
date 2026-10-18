import { randomUUID } from 'node:crypto';
import { analyzeSql } from './classify.js';
import { toPublicConnection } from './config.js';

const SESSION_TTL_MS = 30 * 60 * 1000;

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

export class ReviewManager {
  constructor({ defaultTimeoutMs = 600000, onChange = null } = {}) {
    this.sessions = new Map();
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.onChange = onChange;
  }

  _changed(session, event) {
    try {
      this.onChange?.(event, session);
    } catch {
      /* never let observers break a review */
    }
  }

  create({ sql, params, purpose, connection, timeoutMs }) {
    const id = randomUUID();
    const effectiveTimeout = clampInt(timeoutMs ?? this.defaultTimeoutMs, 5000, 3600000);
    let resolveDecision;
    const decisionPromise = new Promise((resolve) => {
      resolveDecision = resolve;
    });
    let resolveCompletion;
    const completionPromise = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const session = {
      id,
      sql,
      params: Array.isArray(params) ? params : [],
      purpose: purpose ?? null,
      connection: toPublicConnection(connection),
      createdAt: Date.now(),
      expiresAt: Date.now() + effectiveTimeout,
      timeoutMs: effectiveTimeout,
      status: 'pending',
      analysis: analyzeSql(sql),
      result: null,
      error: null,
      decisionPromise,
      completionPromise,
      _resolveDecision: resolveDecision,
      _resolveCompletion: resolveCompletion,
      _timeout: setTimeout(() => this.decide(id, { action: 'timeout' }), effectiveTimeout)
    };
    session._timeout.unref?.();
    this.sessions.set(id, session);
    this._changed(session, 'created');
    return session;
  }

  decide(id, decision) {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'pending') return false;
    clearTimeout(session._timeout);
    const statusByAction = { approve: 'approved', reject: 'rejected', timeout: 'timeout' };
    session.status = statusByAction[decision.action] ?? decision.action;
    if (typeof decision.sql === 'string' && decision.sql.trim()) session.sql = decision.sql;
    session._resolveDecision(decision);
    this._scheduleCleanup(id);
    this._changed(session, 'decided');
    return true;
  }

  markRunning(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.status = 'running';
      this._changed(session, 'running');
    }
  }

  attachResult(id, result) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.result = result;
    session.status = 'done';
    session._resolveCompletion?.({ outcome: 'done' });
    this._scheduleCleanup(id);
    this._changed(session, 'done');
  }

  attachError(id, message) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.error = message;
    session.status = 'error';
    session._resolveCompletion?.({ outcome: 'error' });
    this._scheduleCleanup(id);
    this._changed(session, 'error');
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  getActive() {
    let newest = null;
    for (const session of this.sessions.values()) {
      if (!['pending', 'approved', 'running'].includes(session.status)) continue;
      if (!newest || session.createdAt > newest.createdAt) newest = session;
    }
    return newest;
  }

  listPending() {
    return [...this.sessions.values()]
      .filter((session) => session.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => this.getPublic(session.id));
  }

  getPublic(id) {
    const session = this.get(id);
    if (!session) return null;
    return {
      id: session.id,
      sql: session.sql,
      params: session.params,
      purpose: session.purpose,
      connection: session.connection,
      status: session.status,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      timeoutMs: session.timeoutMs,
      analysis: session.analysis,
      result: session.result,
      error: session.error
    };
  }

  _scheduleCleanup(id) {
    setTimeout(() => this.sessions.delete(id), SESSION_TTL_MS).unref?.();
  }
}
