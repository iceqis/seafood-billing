import { describe, expect, it } from 'vitest';
import { createStatisticsService } from '../../worker/services/statistics.js';

describe('statistics service', () => {
  it('sums every record returned by the paginated client', async () => {
    const orders = [
      { record_id: 'o1', fields: { 日期: '2026-08-23', 金额: 100, 状态: '未结算' } },
      { record_id: 'o2', fields: { 日期: '2026-08-23', 金额: 220, 状态: '已结算' } },
      { record_id: 'o3', fields: { 日期: '2026-08-23', 金额: 500, 状态: '未开单' } },
      { record_id: 'o4', fields: { 日期: '2026-08-01', 金额: 80, 状态: '已结算' } }
    ];
    const purchases = [
      { record_id: 'p1', fields: { 日期: '2026-08-23', 金额: 80 } }
    ];
    const feishu = {
      listAllRecords: async (tableId) => tableId === 'orders' ? orders : purchases
    };
    const service = createStatisticsService(feishu, {
      TABLE_ORDERS: 'orders',
      TABLE_PURCHASES: 'purchases'
    });

    await expect(service.home('2026-08-23')).resolves.toEqual({
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
