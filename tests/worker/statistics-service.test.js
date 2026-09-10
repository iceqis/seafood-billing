import { describe, expect, it } from 'vitest';
import { createStatisticsService } from '../../worker/services/statistics.js';

describe('statistics service', () => {
  it('returns a continuous year trend through the requested month', async () => {
    const orders = [
      { record_id: 'o1', fields: { 日期: '2026-01-08', 金额: 100.125, 状态: '未结算' } },
      { record_id: 'o2', fields: { 日期: '2026-01-09', 金额: 20.125, 状态: '已结算' } },
      { record_id: 'o3', fields: { 日期: '2026-02-01', 金额: 900, 状态: '未开单' } },
      { record_id: 'o4', fields: { 日期: '2025-01-01', 金额: 700, 状态: '已结算' } },
      { record_id: 'o5', fields: { 日期: 'invalid', 金额: 800, 状态: '已结算' } }
    ];
    const purchases = [
      { record_id: 'p1', fields: { 日期: '2026-02-12', 金额: 50.556 } },
      { record_id: 'p2', fields: { 日期: '2027-02-12', 金额: 999 } },
      { record_id: 'p3', fields: { 日期: '', 金额: 888 } }
    ];
    const feishu = {
      listAllRecords: async (tableId) => tableId === 'orders' ? orders : purchases
    };
    const service = createStatisticsService(feishu, {
      TABLE_ORDERS: 'orders', TABLE_PURCHASES: 'purchases'
    });

    await expect(service.home('2026-03-15')).resolves.toMatchObject({
      yearTrend: [
        { month: '2026-01', sales: 120.25, purchases: 0 },
        { month: '2026-02', sales: 0, purchases: 50.56 },
        { month: '2026-03', sales: 0, purchases: 0 }
      ]
    });
  });

  it('returns continuous zero months when there are no records', async () => {
    const feishu = { listAllRecords: async () => [] };
    const service = createStatisticsService(feishu, {
      TABLE_ORDERS: 'orders', TABLE_PURCHASES: 'purchases'
    });

    await expect(service.home('2026-02-08')).resolves.toMatchObject({
      yearTrend: [
        { month: '2026-01', sales: 0, purchases: 0 },
        { month: '2026-02', sales: 0, purchases: 0 }
      ]
    });
  });

  it('sums every record returned by the paginated client', async () => {
    const todayTimestamp = Date.parse('2026-08-23T00:00:00+08:00');
    const orders = [
      { record_id: 'o1', fields: { 日期: todayTimestamp, 金额: 100, 状态: '未结算' } },
      { record_id: 'o2', fields: { 日期: '2026-08-23', 金额: 220, 状态: '已结算' } },
      { record_id: 'o3', fields: { 日期: '2026-08-23', 金额: 500, 状态: '未开单' } },
      { record_id: 'o4', fields: { 日期: '2026-08-01', 金额: 80, 状态: '已结算' } }
    ];
    const purchases = [
      { record_id: 'p1', fields: { 日期: todayTimestamp, 金额: 80 } }
    ];
    const feishu = {
      listAllRecords: async (tableId) => tableId === 'orders' ? orders : purchases
    };
    const service = createStatisticsService(feishu, {
      TABLE_ORDERS: 'orders',
      TABLE_PURCHASES: 'purchases'
    });

    await expect(service.home('2026-08-23')).resolves.toMatchObject({
      todaySales: 320,
      todayDealCount: 2,
      todayPurchase: 80,
      monthSales: 400
    });
  });

  it('returns canonical detail items and totals', async () => {
    const orders = [
      {
        record_id: 'o1',
        fields: { 订单编号: 'X1', 日期: '2026-08-23', 金额: 100, 状态: '未结算' }
      },
      {
        record_id: 'o2',
        fields: { 订单编号: 'X2', 日期: '2026-08-22', 金额: 220, 状态: '已结算' }
      }
    ];
    const feishu = { listAllRecords: async (tableId) => tableId === 'orders' ? orders : [] };
    const service = createStatisticsService(feishu, {
      TABLE_ORDERS: 'orders', TABLE_PURCHASES: 'purchases'
    });

    await expect(service.details('today-sales', '2026-08-23')).resolves.toMatchObject({
      count: 1,
      total: 100,
      items: [{ id: 'X1', status: 'unsettled' }]
    });
  });
});
