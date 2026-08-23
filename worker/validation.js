const TRANSITIONS = Object.freeze({
  pending_ship: new Set(['shipped']),
  shipped: new Set(['pending_bill']),
  pending_bill: new Set(['pending_bill', 'unsettled']),
  unsettled: new Set(['pending_bill', 'settled']),
  settled: new Set(['pending_bill'])
});

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

export function validatePositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ValidationError(`${label}必须是有效数字`);
  if (number <= 0) throw new ValidationError(`${label}必须大于0`);
  return number;
}

export function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError('日期格式必须为YYYY-MM-DD');
  }
  return value;
}

export function validateRequiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new ValidationError(`${label}不能为空`);
  return text;
}

export function validateOrderTransition(from, to) {
  if (!TRANSITIONS[from]?.has(to)) {
    throw new ValidationError(`不允许的订单状态转换：${from} → ${to}`, 409);
  }
}
