import { z } from 'zod';
import { parse, AppError } from '../errors.js';

export const taskIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const reference = z.string().regex(/^\{\{\s*[\w.$]+\s*\}\}$/);
const integer = (min, max) => z.union([z.number().int().min(min).max(max), reference]);
const boolean = z.union([z.boolean(), reference]);
const text = z.string();
const target = z.union([
  z.string().min(1),
  z.object({
    css: text.optional(), role: text.optional(), name: text.optional(),
    text: text.optional(), label: text.optional(), placeholder: text.optional(), testId: text.optional(),
    exact: boolean.optional(), nth: integer(0, 100000).optional(), frame: text.optional(),
  }).strict().refine(value => ['css', 'role', 'text', 'label', 'placeholder', 'testId'].filter(k => value[k] !== undefined).length === 1, '定位器需要且只能指定一种定位方式'),
]);
const common = {
  label: text.optional(), name: text.optional(), timeout: integer(1, 300000).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  when: boolean.optional(), saveAs: z.string().regex(/^(?!__proto__$|constructor$|prototype$)[a-zA-Z_]\w*$/).optional(),
};
const step = (action, fields = {}) => z.object({ ...common, action: z.literal(action), ...fields }).strict();
const loadState = z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']);
const elementState = z.enum(['attached', 'detached', 'visible', 'hidden']);

export const stepSchema = z.discriminatedUnion('action', [
  step('open', { url: text.optional(), waitUntil: loadState.optional() }),
  step('read', { selector: target.optional(), html: boolean.optional(), maxLength: integer(1, 1000000).optional() }),
  step('locate', { selector: target, state: elementState.optional() }),
  step('type', { selector: target, text, submit: text.optional(), delay: integer(0, 1000).optional() }),
  step('click', { selector: target, force: boolean.optional() }),
  step('press', { selector: target.optional(), key: text }),
  step('wait', { ms: integer(0, 120000).optional(), selector: target.optional(), text: text.optional(), exact: boolean.optional(), url: text.optional(), state: text.optional() }),
  step('screenshot', { dir: text.optional(), fullPage: boolean.optional() }),
  step('upload', { selector: target, file: text.optional(), files: z.union([z.array(text).min(1), reference]).optional() }),
  step('download', { selector: target, dir: text.optional() }),
  step('evaluate', { script: text.optional(), expression: text.optional() }),
  step('newPage', { url: text.optional() }),
  step('switchPage', { index: integer(0, 10000) }),
  step('closePage'),
  step('log', { message: text }),
  step('mcp', { tool: text.min(1), arguments: z.record(z.string(), z.unknown()).optional() }),
]);

export const taskSchema = z.object({
  id: taskIdSchema, name: z.string().min(1).max(100), description: text.optional(),
  args: z.array(text).optional(), defaults: z.record(z.string(), z.unknown()).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  steps: z.array(stepSchema).min(1).max(1000).optional(), run: z.custom(value => typeof value === 'function').optional(),
  $schema: text.optional(),
}).strict().refine(value => Boolean(value.steps) !== Boolean(value.run), '任务必须包含 steps 或 run，且只能选择一种');

export function validateTask(input, label = '任务') {
  const task = parse(taskSchema, input, label);
  for (const [index, item] of (task.steps || []).entries()) {
    if (item.action === 'upload' && !item.file && !item.files) throw new AppError(`${label} 步骤 ${index + 1}：upload 需要 file 或 files`);
    if (item.action === 'evaluate' && !item.script && !item.expression) throw new AppError(`${label} 步骤 ${index + 1}：evaluate 需要 script`);
    if (item.action === 'wait') {
      const modes = ['ms', 'selector', 'text', 'url'].filter(key => item[key] !== undefined);
      if (modes.length > 1) throw new AppError(`${label} 步骤 ${index + 1}：wait 只能选择一种等待方式`);
    }
  }
  return task;
}
