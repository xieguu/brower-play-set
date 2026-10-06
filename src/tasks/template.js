import { AppError } from '../errors.js';

const blocked = new Set(['__proto__', 'prototype', 'constructor']);
function resolve(scope, expression) {
  let current = scope;
  for (const key of expression.split('.')) {
    if (blocked.has(key) || current == null || !Object.hasOwn(Object(current), key)) {
      throw new AppError(`未定义的模板变量：${expression}`);
    }
    current = current[key];
  }
  if (current === undefined) throw new AppError(`未定义的模板变量：${expression}`);
  return current;
}

/** Whole-value references retain their JSON type; missing references always fail. */
export function interpolate(value, scope) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([\w.$]+)\s*\}\}$/);
    if (whole) return resolve(scope, whole[1]);
    return value.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, expression) => {
      const result = resolve(scope, expression);
      return result !== null && typeof result === 'object' ? JSON.stringify(result) : String(result);
    });
  }
  if (Array.isArray(value)) return value.map(item => interpolate(item, scope));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, scope)]));
  }
  return value;
}
