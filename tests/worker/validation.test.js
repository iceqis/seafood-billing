import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  validateDate,
  validateOrderTransition,
  validatePositiveNumber,
  validateRequiredText
} from '../../worker/validation.js';

describe('validation', () => {
  it('accepts positive numbers', () => {
    expect(validatePositiveNumber('5.5', '实际发货重量')).toBe(5.5);
  });

  it('rejects zero and invalid numbers', () => {
    expect(() => validatePositiveNumber(0, '单价')).toThrow('单价必须大于0');
    expect(() => validatePositiveNumber('abc', '单价')).toThrow('单价必须是有效数字');
  });

  it('validates dates and required text', () => {
    expect(validateDate('2026-08-23')).toBe('2026-08-23');
    expect(() => validateDate('2026/08/23')).toThrow('日期格式必须为YYYY-MM-DD');
    expect(validateRequiredText('  基围虾  ', '商品')).toBe('基围虾');
    expect(() => validateRequiredText('   ', '商品')).toThrow('商品不能为空');
  });

  it.each([
    ['pending_ship', 'shipped'],
    ['shipped', 'pending_bill'],
    ['pending_bill', 'unsettled'],
    ['unsettled', 'settled'],
    ['settled', 'pending_bill']
  ])('allows %s to %s', (from, to) => {
    expect(() => validateOrderTransition(from, to)).not.toThrow();
  });

  it('rejects skipping states with a conflict error', () => {
    expect(() => validateOrderTransition('pending_ship', 'settled')).toThrow('不允许的订单状态转换');
    try {
      validateOrderTransition('pending_ship', 'settled');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.status).toBe(409);
    }
  });
});
