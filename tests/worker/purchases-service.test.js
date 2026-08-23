import { describe, expect, it } from 'vitest';
import { createPurchasesService } from '../../worker/services/purchases.js';

function purchaseRecord(id, date = '2026-08-23') {
  return {
    record_id: `rec_${id}`,
    fields: {
      进货单号: id,
      日期: date,
      供应商: '甲供应商',
      商品: '基围虾',
      规格: '30头',
      进货重量: 5,
      进货单价: 20,
      金额: 100
    }
  };
}

describe('purchases service', () => {
  it('cleans the losing duplicate and reallocates concurrent purchase creations', async () => {
    const records = [];
    const removed = [];
    let sequence = 0;
    let firstWaveCount = 0;
    let releaseFirstWave;
    const firstWave = new Promise((resolve) => { releaseFirstWave = resolve; });
    const feishu = {
      listAllRecords: async () => structuredClone(records),
      createRecord: async (_tableId, fields) => {
        sequence += 1;
        const record = { record_id: `rec_${String(sequence).padStart(3, '0')}`, fields: structuredClone(fields) };
        records.push(record);
        if (fields['进货单号'] === 'CGD20260823001') {
          firstWaveCount += 1;
          if (firstWaveCount === 2) releaseFirstWave();
          await firstWave;
        }
        return structuredClone(record);
      },
      deleteRecord: async (_tableId, recordId) => {
        removed.push(recordId);
        const index = records.findIndex((record) => record.record_id === recordId);
        if (index >= 0) records.splice(index, 1);
        return null;
      }
    };
    const service = createPurchasesService(feishu, { TABLE_PURCHASES: 'purchases' });
    const input = {
      date: '2026-08-23', supplier: '甲供应商', spec: '30头', weight: 5, price: 20
    };

    const created = await Promise.all([service.create(input), service.create(input)]);

    expect(created.map((purchase) => purchase.id).sort()).toEqual([
      'CGD20260823001',
      'CGD20260823002'
    ]);
    expect(records.map((record) => record.fields['进货单号']).sort()).toEqual([
      'CGD20260823001',
      'CGD20260823002'
    ]);
    expect(removed).toEqual(['rec_002']);
  });

  it('creates the next daily purchase ID without falling back to record count', async () => {
    const records = [
      purchaseRecord('CGD20260823002'),
      purchaseRecord('CGD20260822099', '2026-08-22'),
      purchaseRecord('CGD20260823bad')
    ];
    const created = [];
    const feishu = {
      listAllRecords: async () => structuredClone([
        ...records,
        ...created.map((fields) => ({ record_id: 'created', fields }))
      ]),
      createRecord: async (_tableId, fields) => {
        created.push(fields);
        return { record_id: 'created', fields };
      }
    };
    const service = createPurchasesService(feishu, { TABLE_PURCHASES: 'purchases' });

    await expect(service.create({
      date: '2026-08-23', supplier: '甲供应商', spec: '30头', weight: 5, price: 20
    })).resolves.toMatchObject({ id: 'CGD20260823003', amount: 100 });
    expect(created[0]['进货单号']).toBe('CGD20260823003');
  });

  it('rejects purchase creation at the daily sequence limit', async () => {
    const feishu = {
      listAllRecords: async () => [purchaseRecord('CGD20260823999')],
      createRecord: async () => { throw new Error('must not create'); }
    };
    const service = createPurchasesService(feishu, { TABLE_PURCHASES: 'purchases' });

    await expect(service.create({
      date: '2026-08-23', supplier: '甲供应商', spec: '30头', weight: 5, price: 20
    })).rejects.toMatchObject({ status: 409 });
  });

  it('lists and removes purchase records by document ID', async () => {
    const records = [purchaseRecord('CGD20260823001')];
    const removed = [];
    const feishu = {
      listAllRecords: async () => structuredClone(records),
      deleteRecord: async (_tableId, recordId) => { removed.push(recordId); return null; }
    };
    const service = createPurchasesService(feishu, { TABLE_PURCHASES: 'purchases' });

    await expect(service.list({ date: '2026-08-23' })).resolves.toMatchObject([{ id: 'CGD20260823001' }]);
    await expect(service.remove('CGD20260823001')).resolves.toBeNull();
    expect(removed).toEqual(['rec_CGD20260823001']);
  });
});
