import { FIELDS, supplierFromFeishu } from '../field-mappers.js';
import { ValidationError, validateRequiredText } from '../validation.js';

export function createSuppliersService(feishu, env) {
  const tableId = env.TABLE_SUPPLIERS;

  async function list() {
    return (await feishu.listAllRecords(tableId)).map(supplierFromFeishu);
  }

  async function create(input) {
    const name = validateRequiredText(input?.name, '供应商名称');
    return supplierFromFeishu(await feishu.createRecord(tableId, {
      [FIELDS.suppliers.name]: name,
      [FIELDS.suppliers.phone]: input.phone || '',
      [FIELDS.suppliers.remark]: input.remark || ''
    }));
  }

  async function remove(name) {
    const records = await feishu.listAllRecords(tableId, {
      field_name: FIELDS.suppliers.name,
      operator: 'is',
      value: [name]
    });
    const record = records.find((item) => item.fields?.[FIELDS.suppliers.name] === name);
    if (!record) throw new ValidationError('供应商不存在', 404);
    await feishu.deleteRecord(tableId, record.record_id);
    return null;
  }

  return { list, create, remove };
}
