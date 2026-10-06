export class AppError extends Error {
  constructor(message, status = 400, options) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
  }
}

export function parse(schema, input, label = '配置') {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(`${label}：${result.error.issues.map(i => `${i.path.join('.') || '内容'} ${i.message}`).join('；')}`);
  }
  return result.data;
}
