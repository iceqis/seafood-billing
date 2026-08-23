import { describe, expect, it } from 'vitest';
import { FeishuError } from '../../worker/feishu-client.js';
import { createOrdersService, nextDocumentId } from '../../worker/services/orders.js';

function orderRecord(id, customer, status, overrides = {}) {
  return {
    record_id: `rec_${id}`,
    fields: {
      订单编号: id,
      日期: '2026-08-23',
      客户: customer,
      商品: '基围虾',
      规格: '30头',
      报货重量: 5,
      实际发货重量: 5,
      单价: 40,
      金额: 200,
      状态: status,
      是否结算: status === '已结算',
      ...overrides
    }
  };
}

function matchesFilter(record, filter) {
  if (!filter) return true;
  if (filter.conjunction === 'and') {
    return filter.conditions.every((condition) => matchesFilter(record, condition));
  }
  const actual = record.fields[filter.field_name];
  if (filter.operator === 'is') return filter.value.includes(actual);
  if (filter.operator === 'isAnyOf') return filter.value.includes(actual);
  return true;
}

function fakeOrdersClient(initialRecords) {
  const records = structuredClone(initialRecords);
  const calls = { list: [], update: [], create: [], remove: [] };
  return {
    calls,
    records,
    listAllRecords: async (tableId, filter) => {
      calls.list.push({ tableId, filter });
      return structuredClone(records.filter((record) => matchesFilter(record, filter)));
    },
    updateRecord: async (_tableId, recordId, fields) => {
      calls.update.push({ recordId, fields });
      const record = records.find((item) => item.record_id === recordId);
      Object.assign(record.fields, fields);
      return structuredClone(record);
    },
    createRecord: async (_tableId, fields) => {
      calls.create.push(fields);
      const record = { record_id: `rec_${records.length + 1}`, fields: structuredClone(fields) };
      records.push(record);
      return structuredClone(record);
    },
    deleteRecord: async (_tableId, recordId) => {
      calls.remove.push(recordId);
      const index = records.findIndex((item) => item.record_id === recordId);
      if (index >= 0) records.splice(index, 1);
      return null;
    }
  };
}

const ordersEnv = { TABLE_ORDERS: 'orders' };

function concurrentOrdersClient() {
  const records = [];
  const removed = [];
  let sequence = 0;
  let firstWaveCount = 0;
  let releaseFirstWave;
  const firstWave = new Promise((resolve) => { releaseFirstWave = resolve; });
  return {
    records,
    removed,
    listAllRecords: async (_tableId, filter) => structuredClone(
      records.filter((record) => matchesFilter(record, filter))
    ),
    createRecord: async (_tableId, fields) => {
      sequence += 1;
      const record = { record_id: `rec_${String(sequence).padStart(3, '0')}`, fields: structuredClone(fields) };
      records.push(record);
      if (fields['订单编号'] === 'XSD20260823001') {
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
}

describe('orders service', () => {
  it('exposes explicit business operations without a generic update', () => {
    const service = createOrdersService(fakeOrdersClient([]), ordersEnv);
    expect(Object.keys(service).sort()).toEqual([
      'bill',
      'createPreorder',
      'edit',
      'list',
      'price',
      'remove',
      'settle',
      'ship'
    ]);
  });

  it('allocates the next ID from only valid IDs for the requested date', () => {
    expect(nextDocumentId('XSD', '2026-08-23', [
      'XSD20260823001',
      'XSD202608230007',
      'XSD20260823007',
      'XSD20260822099',
      'CGD20260823012',
      'not-an-id'
    ])).toBe('XSD20260823008');
  });

  it('rejects allocation after the daily sequence reaches 999', () => {
    expect(() => nextDocumentId('XSD', '2026-08-23', ['XSD20260823999']))
      .toThrow('当日单据数量已达到上限');
    try {
      nextDocumentId('XSD', '2026-08-23', ['XSD20260823999']);
    } catch (error) {
      expect(error.status).toBe(409);
    }
  });

  it('only ships pending orders and writes the Chinese status', async () => {
    const client = fakeOrdersClient([orderRecord('XSD20260823001', '甲客户', '待发货')]);
    const service = createOrdersService(client, ordersEnv);

    await expect(service.ship('XSD20260823001', 5.5)).resolves.toMatchObject({
      status: 'shipped',
      actualWeight: 5.5
    });
    expect(client.calls.update[0].fields).toMatchObject({ 实际发货重量: 5.5, 状态: '已发货' });

    await expect(service.ship('XSD20260823001', 6)).rejects.toMatchObject({ status: 409 });
  });

  it('only prices shipped orders and calculates the amount', async () => {
    const client = fakeOrdersClient([orderRecord('XSD20260823001', '甲客户', '已发货')]);
    const service = createOrdersService(client, ordersEnv);

    await expect(service.price('XSD20260823001', 42)).resolves.toMatchObject({
      status: 'pending_bill',
      price: 42,
      amount: 210
    });
    expect(client.calls.update[0].fields).toMatchObject({ 单价: 42, 金额: 210, 状态: '未开单' });
  });

  it('rejects billing orders from different customers without partial writes', async () => {
    const client = fakeOrdersClient([
      orderRecord('XSD20260823001', '甲客户', '未开单'),
      orderRecord('XSD20260823002', '乙客户', '未开单')
    ]);
    const service = createOrdersService(client, ordersEnv);

    await expect(service.bill(['XSD20260823001', 'XSD20260823002'], '甲客户'))
      .rejects.toMatchObject({ status: 409 });
    expect(client.calls.update).toHaveLength(0);
  });

  it.each([
    ['missing ID', [orderRecord('XSD20260823001', '甲客户', '未开单')], ['XSD20260823001', 'missing']],
    ['wrong state', [
      orderRecord('XSD20260823001', '甲客户', '未开单'),
      orderRecord('XSD20260823002', '甲客户', '已发货')
    ], ['XSD20260823001', 'XSD20260823002']]
  ])('rejects billing with %s before any writes', async (_kind, records, ids) => {
    const client = fakeOrdersClient(records);
    const service = createOrdersService(client, ordersEnv);

    await expect(service.bill(ids, '甲客户')).rejects.toMatchObject({ status: 409 });
    expect(client.calls.update).toHaveLength(0);
  });

  it('bills a fully valid customer batch', async () => {
    const client = fakeOrdersClient([
      orderRecord('XSD20260823001', '甲客户', '未开单'),
      orderRecord('XSD20260823002', '甲客户', '未开单', { 金额: 220 })
    ]);
    const service = createOrdersService(client, ordersEnv);

    await expect(service.bill(['XSD20260823001', 'XSD20260823002'], '甲客户')).resolves.toMatchObject({
      count: 2,
      totalAmount: 420,
      orders: [{ status: 'unsettled' }, { status: 'unsettled' }]
    });
  });

  it('only settles unsettled orders and never partially writes invalid batches', async () => {
    const client = fakeOrdersClient([
      orderRecord('XSD20260823001', '甲客户', '未结算'),
      orderRecord('XSD20260823002', '甲客户', '未开单')
    ]);
    const service = createOrdersService(client, ordersEnv);

    await expect(service.settle(['XSD20260823001', 'XSD20260823002']))
      .rejects.toMatchObject({ status: 409 });
    expect(client.calls.update).toHaveLength(0);
  });

  it('settles a fully valid batch', async () => {
    const client = fakeOrdersClient([
      orderRecord('XSD20260823001', '甲客户', '未结算'),
      orderRecord('XSD20260823002', '乙客户', '未结算', { 金额: 220 })
    ]);
    const service = createOrdersService(client, ordersEnv);

    await expect(service.settle(['XSD20260823001', 'XSD20260823002'])).resolves.toMatchObject({
      count: 2,
      totalAmount: 420,
      orders: [{ status: 'settled' }, { status: 'settled' }]
    });
  });

  it('reallocates after a fresh collision before creating', async () => {
    const snapshots = [
      [orderRecord('XSD20260823001', '甲客户', '待发货')],
      [
        orderRecord('XSD20260823001', '甲客户', '待发货'),
        orderRecord('XSD20260823002', '甲客户', '待发货')
      ],
      [
        orderRecord('XSD20260823001', '甲客户', '待发货'),
        orderRecord('XSD20260823002', '甲客户', '待发货')
      ]
    ];
    const created = [];
    const feishu = {
      listAllRecords: async () => structuredClone(snapshots.shift() ?? created.map((fields) => ({
        record_id: 'created', fields
      }))),
      createRecord: async (_tableId, fields) => {
        created.push(fields);
        return { record_id: 'created', fields };
      }
    };
    const service = createOrdersService(feishu, ordersEnv);

    await expect(service.createPreorder({
      date: '2026-08-23', customer: '甲客户', spec: '30头', orderWeight: 5
    })).resolves.toMatchObject({ id: 'XSD20260823003' });
    expect(created[0]['订单编号']).toBe('XSD20260823003');
  });

  it('returns 409 after three fresh allocation collisions', async () => {
    const snapshots = [
      ['XSD20260823001'],
      ['XSD20260823001', 'XSD20260823002'],
      ['XSD20260823001', 'XSD20260823002', 'XSD20260823003'],
      ['XSD20260823001', 'XSD20260823002', 'XSD20260823003', 'XSD20260823004']
    ];
    const feishu = {
      listAllRecords: async () => (snapshots.shift() ?? []).map((id) => orderRecord(id, '甲客户', '待发货')),
      createRecord: async () => { throw new Error('must not create'); }
    };
    const service = createOrdersService(feishu, ordersEnv);

    await expect(service.createPreorder({
      date: '2026-08-23', customer: '甲客户', spec: '30头', orderWeight: 5
    })).rejects.toMatchObject({ status: 409 });
  });

  it('cleans only the losing duplicate and reallocates concurrent order creations', async () => {
    const client = concurrentOrdersClient();
    const service = createOrdersService(client, ordersEnv);
    const input = { date: '2026-08-23', customer: '甲客户', spec: '30头', orderWeight: 5 };

    const created = await Promise.all([
      service.createPreorder(input),
      service.createPreorder(input)
    ]);

    expect(created.map((order) => order.id).sort()).toEqual([
      'XSD20260823001',
      'XSD20260823002'
    ]);
    expect(client.records.map((record) => record.fields['订单编号']).sort()).toEqual([
      'XSD20260823001',
      'XSD20260823002'
    ]);
    expect(client.removed).toEqual(['rec_002']);
  });

  it('cleans its own duplicate on every attempt and returns 409 after three losses', async () => {
    const records = [];
    const removed = [];
    let sequence = 0;
    const feishu = {
      listAllRecords: async (_tableId, filter) => structuredClone(
        records.filter((record) => matchesFilter(record, filter))
      ),
      createRecord: async (_tableId, fields) => {
        sequence += 1;
        const own = { record_id: `zz_${sequence}`, fields: structuredClone(fields) };
        const winner = { record_id: `aa_${sequence}`, fields: structuredClone(fields) };
        records.push(own, winner);
        return structuredClone(own);
      },
      deleteRecord: async (_tableId, recordId) => {
        removed.push(recordId);
        const index = records.findIndex((record) => record.record_id === recordId);
        if (index >= 0) records.splice(index, 1);
        return null;
      }
    };
    const service = createOrdersService(feishu, ordersEnv);

    await expect(service.createPreorder({
      date: '2026-08-23', customer: '甲客户', spec: '30头', orderWeight: 5
    })).rejects.toMatchObject({ status: 409 });
    expect(removed).toEqual(['zz_1', 'zz_2', 'zz_3']);
    expect(records.map((record) => record.record_id)).toEqual(['aa_1', 'aa_2', 'aa_3']);
  });

  it('reallocates after a safely recognized Feishu create conflict', async () => {
    const records = [];
    let createCount = 0;
    const feishu = {
      listAllRecords: async (_tableId, filter) => structuredClone(
        records.filter((record) => matchesFilter(record, filter))
      ),
      createRecord: async (_tableId, fields) => {
        createCount += 1;
        if (createCount === 1) {
          records.push({ record_id: 'competing', fields: structuredClone(fields) });
          throw new FeishuError('写入飞书数据失败', { upstreamStatus: 409 });
        }
        const record = { record_id: 'created', fields: structuredClone(fields) };
        records.push(record);
        return structuredClone(record);
      },
      deleteRecord: async () => { throw new Error('must not delete another request record'); }
    };
    const service = createOrdersService(feishu, ordersEnv);

    await expect(service.createPreorder({
      date: '2026-08-23', customer: '甲客户', spec: '30头', orderWeight: 5
    })).resolves.toMatchObject({ id: 'XSD20260823002' });
    expect(createCount).toBe(2);
  });

  it.each([
    ['bill', '未开单', '未结算', 'unsettled'],
    ['settle', '未结算', '已结算', 'settled']
  ])('continues %s after one Feishu update failure and reports the exact partial result', async (
    operation,
    initialStatus,
    updatedStatus,
    canonicalStatus
  ) => {
    const client = fakeOrdersClient([
      orderRecord('XSD20260823001', '甲客户', initialStatus),
      orderRecord('XSD20260823002', '甲客户', initialStatus),
      orderRecord('XSD20260823003', '甲客户', initialStatus)
    ]);
    const updateRecord = client.updateRecord;
    client.updateRecord = async (tableId, recordId, fields) => {
      if (recordId === 'rec_XSD20260823002') throw new FeishuError('写入飞书数据失败');
      return updateRecord(tableId, recordId, fields);
    };
    const service = createOrdersService(client, ordersEnv);

    const result = operation === 'bill'
      ? await service.bill([
        'XSD20260823001', 'XSD20260823002', 'XSD20260823003'
      ], '甲客户')
      : await service.settle(['XSD20260823001', 'XSD20260823002', 'XSD20260823003']);

    expect(result).toMatchObject({
      count: 2,
      successCount: 2,
      skippedCount: 1,
      orders: [{ id: 'XSD20260823001', status: canonicalStatus }, { id: 'XSD20260823003', status: canonicalStatus }],
      reasons: [{ id: 'XSD20260823002', reason: '飞书更新失败' }]
    });
    expect(client.records.map((record) => record.fields['状态'])).toEqual([
      updatedStatus,
      initialStatus,
      updatedStatus
    ]);
  });
});
