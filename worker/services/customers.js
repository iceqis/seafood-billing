import { FIELDS, customerFromFeishu } from '../field-mappers.js';
import { ValidationError, validateRequiredText } from '../validation.js';

export function createCustomersService(feishu, env) {
  const tableId = env.TABLE_CUSTOMERS;

  async function list() {
    return (await feishu.listAllRecords(tableId)).map(customerFromFeishu);
  }

  async function create(input) {
    const name = validateRequiredText(input?.name, '客户名称');
    return customerFromFeishu(await feishu.createRecord(tableId, {
      [FIELDS.customers.name]: name,
      [FIELDS.customers.phone]: input.phone || '',
      [FIELDS.customers.settlement]: input.settlement || '',
      [FIELDS.customers.remark]: input.remark || ''
    }));
  }

  async function remove(name) {
    const records = await feishu.listAllRecords(tableId, {
      field_name: FIELDS.customers.name,
      operator: 'is',
      value: [name]
    });
    const record = records.find((item) => item.fields?.[FIELDS.customers.name] === name);
    if (!record) throw new ValidationError('客户不存在', 404);
    await feishu.deleteRecord(tableId, record.record_id);
    return null;
  }

  return { list, create, remove };
}
