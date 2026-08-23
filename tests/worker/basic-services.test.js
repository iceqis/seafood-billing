import { describe, expect, it } from 'vitest';
import { createCustomersService } from '../../worker/services/customers.js';
import { createProductsService } from '../../worker/services/products.js';
import { createSuppliersService } from '../../worker/services/suppliers.js';

function fakeClient(records) {
  const stored = structuredClone(records);
  const calls = { create: [], remove: [] };
  return {
    calls,
    listAllRecords: async (_tableId, filter) => stored.filter((record) => {
      if (!filter) return true;
      return filter.value.includes(record.fields[filter.field_name]);
    }),
    createRecord: async (_tableId, fields) => {
      calls.create.push(fields);
      return { record_id: 'created', fields };
    },
    deleteRecord: async (_tableId, recordId) => {
      calls.remove.push(recordId);
      return null;
    }
  };
}

describe('basic data services', () => {
  it('lists, creates and removes customers using existing fields', async () => {
    const client = fakeClient([
      { record_id: 'c1', fields: { 客户名称: '甲客户', 联系电话: '138', 结算方式: '月结', 备注: '备注' } }
    ]);
    const service = createCustomersService(client, { TABLE_CUSTOMERS: 'customers' });

    await expect(service.list()).resolves.toEqual([{
      recordId: 'c1', name: '甲客户', phone: '138', settlement: '月结', remark: '备注'
    }]);
    await expect(service.create({ name: '乙客户', phone: '139', settlement: '现结', remark: '' }))
      .resolves.toMatchObject({ name: '乙客户', phone: '139' });
    expect(client.calls.create[0]).toEqual({ 客户名称: '乙客户', 联系电话: '139', 结算方式: '现结', 备注: '' });
    await expect(service.remove('甲客户')).resolves.toBeNull();
    expect(client.calls.remove).toEqual(['c1']);
  });

  it('lists, creates and removes suppliers using existing fields', async () => {
    const client = fakeClient([
      { record_id: 's1', fields: { 供应商名称: '甲供应商', 联系电话: '138', 备注: '码头' } }
    ]);
    const service = createSuppliersService(client, { TABLE_SUPPLIERS: 'suppliers' });

    await expect(service.list()).resolves.toMatchObject([{ name: '甲供应商', phone: '138' }]);
    await service.create({ name: '乙供应商', phone: '139', remark: '市场' });
    expect(client.calls.create[0]).toEqual({ 供应商名称: '乙供应商', 联系电话: '139', 备注: '市场' });
    await service.remove('甲供应商');
    expect(client.calls.remove).toEqual(['s1']);
  });

  it('lists, creates and removes products using existing fields', async () => {
    const client = fakeClient([
      { record_id: 'p1', fields: { 商品名称: '基围虾', 规格: '30头' } }
    ]);
    const service = createProductsService(client, { TABLE_PRODUCTS: 'products' });

    await expect(service.list()).resolves.toEqual([{ recordId: 'p1', name: '基围虾', specs: '30头' }]);
    await service.create({ name: '罗氏虾', specs: '20头' });
    expect(client.calls.create[0]).toEqual({ 商品名称: '罗氏虾', 规格: '20头' });
    await service.remove('基围虾');
    expect(client.calls.remove).toEqual(['p1']);
  });

  it('returns 404 when the named record does not exist', async () => {
    const service = createCustomersService(fakeClient([]), { TABLE_CUSTOMERS: 'customers' });
    await expect(service.remove('不存在')).rejects.toMatchObject({ status: 404 });
  });
});
