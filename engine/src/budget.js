import { readEnv } from './paths.js';

const DEFAULT_RESPONSE_BUDGET = 50000;
const MIN_RESPONSE_BUDGET = 5000;
const MAX_RESPONSE_BUDGET = 500000;

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

export function getResponseBudget() {
  return clampInt(
    readEnv('MAX_RESPONSE_CHARS') ?? DEFAULT_RESPONSE_BUDGET,
    MIN_RESPONSE_BUDGET,
    MAX_RESPONSE_BUDGET
  );
}

export function jsonSize(value) {
  return JSON.stringify(value).length;
}

export function trimPayloadArray(payload, arrayKey, budget = getResponseBudget()) {
  const array = payload?.[arrayKey];
  if (!Array.isArray(array) || array.length === 0) return { omitted: 0 };
  if (jsonSize(payload) <= budget) return { omitted: 0 };

  const reserve = 300;
  let used = jsonSize({ ...payload, [arrayKey]: [] });
  const kept = [];
  for (const item of array) {
    const size = JSON.stringify(item).length + 1;
    if (used + size > budget - reserve) break;
    used += size;
    kept.push(item);
  }
  const omitted = array.length - kept.length;
  payload[arrayKey] = kept;
  return { omitted };
}
