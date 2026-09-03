import {
  FIELDS,
  STATUS_TO_FEISHU,
  dateFromFeishu,
  orderFromFeishu,
  statusFromFeishu,
  statusToFeishu,
  todayInShanghai
} from '../field-mappers.js';
import { FeishuError } from '../feishu-client.js';
import {
  ValidationError,
  validateDate,
  validatePositiveNumber,
  validateRequiredText
} from '../validation.js';

function condition(fieldName, operator, value) {
  return { field_name: fieldName, operator, value: Array.isArray(value) ? value : [value] };
}

function andFilter(conditions) {
  if (conditions.length === 0) return null;
  if (conditions.length === 1) return conditions[0];
  return { conjunction: 'and', conditions };
}

function requireIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError('订单ID列表不能为空');
  }
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError('订单ID列表不能重复', 409);
  }
  return ids;
}

function conflict(message) {
  return new ValidationError(message, 409);
}

export function nextDocumentId(prefix, date, existingIds) {
  const compactDate = date.replaceAll('-', '');
  const pattern = new RegExp(`^${prefix}${compactDate}(\\d{3})$`);
  const max = existingIds.reduce((current, id) => {
    const match = pattern.exec(id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  if (max >= 999) throw new ValidationError('当日单据数量已达到上限', 409);
  return `${prefix}${compactDate}${String(max + 1).padStart(3, '0')}`;
}

export async function allocateDocumentId(feishu, tableId, prefix, date, idField, dateField) {
  const recordsForDate = (records) => records.filter(
    (record) => dateFromFeishu(record.fields?.[dateField]) === date
  );
  const initialRecords = recordsForDate(await feishu.listAllRecords(tableId));
  let candidate = nextDocumentId(prefix, date, initialRecords.map((record) => record.fields?.[idField] ?? ''));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const freshRecords = recordsForDate(await feishu.listAllRecords(tableId));
    const freshIds = freshRecords.map((record) => record.fields?.[idField] ?? '');
    if (!freshIds.includes(candidate)) return candidate;
    candidate = nextDocumentId(prefix, date, freshIds);
  }

  throw new ValidationError('单据编号冲突，请重试', 409);
}

function isRecognizedCreateConflict(error) {
  return (error instanceof FeishuError && error.upstreamStatus === 409)
    || (error instanceof ValidationError && error.status === 409);
}

export async function createUniqueDocument(
  feishu,
  tableId,
  prefix,
  date,
  idField,
  dateField,
  fieldsForId
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = await allocateDocumentId(feishu, tableId, prefix, date, idField, dateField);
    let created;
    try {
      created = await feishu.createRecord(tableId, fieldsForId(id));
    } catch (error) {
      if (isRecognizedCreateConflict(error)) continue;
      throw error;
    }

    // Feishu has no transaction/unique constraint here. This post-create check is a
    // best-effort tie-breaker: stable record_id ordering elects one winner, and a
    // loser deletes only the record returned by its own create call before retrying.
    const matching = (await feishu.listAllRecords(
      tableId,
      condition(idField, 'is', id)
    ))
      .filter((record) => record.fields?.[idField] === id)
      .sort((left, right) => String(left.record_id).localeCompare(String(right.record_id)));
    const winner = matching[0];
    if (winner?.record_id === created.record_id) return created;

    await feishu.deleteRecord(tableId, created.record_id);
  }

  throw new ValidationError('单据编号冲突，请重试', 409);
}

export function createOrdersService(feishu, env) {
  const tableId = env.TABLE_ORDERS;

  async function findRecord(id) {
    const records = await feishu.listAllRecords(tableId, condition(FIELDS.orders.id, 'is', id));
    const record = records.find((item) => item.fields?.[FIELDS.orders.id] === id);
    if (!record) throw new ValidationError('订单不存在', 404);
    return record;
  }

  async function list(filters = {}) {
    const conditions = [];
    let requestedStatuses = [];
    if (filters.customer) conditions.push(condition(FIELDS.orders.customer, 'is', filters.customer));
    if (filters.status) {
      requestedStatuses = String(filters.status)
        .split(',')
        .map((status) => statusFromFeishu(status.trim()))
        .filter(Boolean);
      if (requestedStatuses.length === 1) {
        conditions.push(condition(
          FIELDS.orders.status,
          'is',
          statusToFeishu(requestedStatuses[0])
        ));
      }
    }
    let orders = (await feishu.listAllRecords(tableId, andFilter(conditions))).map(orderFromFeishu);
    if (filters.date) orders = orders.filter((order) => order.date === filters.date);
    if (requestedStatuses.length > 1) {
      orders = orders.filter((order) => requestedStatuses.includes(order.status));
    }
    return orders;
  }

  async function createPreorder(input) {
    if (!input?.customer || !input?.spec || !input?.orderWeight) {
      throw new ValidationError('客户、规格、报货重量不能为空');
    }
    const date = input.date ? validateDate(input.date) : todayInShanghai();
    const customer = validateRequiredText(input.customer, '客户');
    const spec = validateRequiredText(input.spec, '规格');
    const orderWeight = validatePositiveNumber(input.orderWeight, '报货重量');
    const record = await createUniqueDocument(
      feishu,
      tableId,
      'XSD',
      date,
      FIELDS.orders.id,
      FIELDS.orders.date,
      (id) => ({
        [FIELDS.orders.id]: id,
        [FIELDS.orders.date]: date,
        [FIELDS.orders.customer]: customer,
        [FIELDS.orders.product]: input.product || '基围虾',
        [FIELDS.orders.spec]: spec,
        [FIELDS.orders.orderWeight]: orderWeight,
        [FIELDS.orders.actualWeight]: '',
        [FIELDS.orders.price]: '',
        [FIELDS.orders.amount]: '',
        [FIELDS.orders.status]: STATUS_TO_FEISHU.pending_ship,
        [FIELDS.orders.settled]: false
      })
    );
    return orderFromFeishu(record);
  }

  async function ship(id, value) {
    const actualWeight = validatePositiveNumber(value, '实际发货重量');
    const record = await findRecord(id);
    const current = orderFromFeishu(record);
    if (current.status !== 'pending_ship') throw conflict('仅待发货订单可以发货');
    return orderFromFeishu(await feishu.updateRecord(tableId, record.record_id, {
      [FIELDS.orders.actualWeight]: actualWeight,
      [FIELDS.orders.status]: STATUS_TO_FEISHU.shipped
    }));
  }

  async function price(id, value) {
    const unitPrice = validatePositiveNumber(value, '单价');
    const record = await findRecord(id);
    const current = orderFromFeishu(record);
    if (current.status !== 'shipped') throw conflict('仅已发货订单可以定价');
    const amount = Number((current.actualWeight * unitPrice).toFixed(2));
    return orderFromFeishu(await feishu.updateRecord(tableId, record.record_id, {
      [FIELDS.orders.price]: unitPrice,
      [FIELDS.orders.amount]: amount,
      [FIELDS.orders.status]: STATUS_TO_FEISHU.pending_bill
    }));
  }

  async function edit(id, input) {
    const actualWeight = validatePositiveNumber(input?.actualWeight, '实际发货重量');
    const unitPrice = validatePositiveNumber(input?.price, '单价');
    const record = await findRecord(id);
    const current = orderFromFeishu(record);
    if (!['pending_bill', 'unsettled', 'settled'].includes(current.status)) {
      throw conflict('当前订单状态不允许修改');
    }
    return orderFromFeishu(await feishu.updateRecord(tableId, record.record_id, {
      [FIELDS.orders.actualWeight]: actualWeight,
      [FIELDS.orders.price]: unitPrice,
      [FIELDS.orders.amount]: Number((actualWeight * unitPrice).toFixed(2)),
      [FIELDS.orders.status]: STATUS_TO_FEISHU.pending_bill,
      [FIELDS.orders.settled]: false
    }));
  }

  async function bill(ids, requestedCustomer) {
    requireIds(ids);
    const customer = validateRequiredText(requestedCustomer, '客户');
    const records = await feishu.listAllRecords(tableId, condition(FIELDS.orders.id, 'isAnyOf', ids));
    const byId = new Map(records.map((record) => [record.fields?.[FIELDS.orders.id], record]));
    const selected = ids.map((id) => byId.get(id));
    if (selected.some((record) => !record)) throw conflict('部分订单不存在');

    const orders = selected.map(orderFromFeishu);
    if (orders.some((order) => order.customer !== customer)) throw conflict('开单订单必须属于同一客户');
    if (orders.some((order) => order.status !== 'pending_bill')) throw conflict('仅未开单订单可以统一开单');

    return applyBatchUpdates(feishu, tableId, selected, {
      [FIELDS.orders.status]: STATUS_TO_FEISHU.unsettled
    });
  }

  async function settle(ids) {
    requireIds(ids);
    const records = await feishu.listAllRecords(tableId, condition(FIELDS.orders.id, 'isAnyOf', ids));
    const byId = new Map(records.map((record) => [record.fields?.[FIELDS.orders.id], record]));
    const selected = ids.map((id) => byId.get(id));
    if (selected.some((record) => !record)) throw conflict('部分订单不存在');
    if (selected.map(orderFromFeishu).some((order) => order.status !== 'unsettled')) {
      throw conflict('仅未结算订单可以结算');
    }

    return applyBatchUpdates(feishu, tableId, selected, {
      [FIELDS.orders.status]: STATUS_TO_FEISHU.settled,
      [FIELDS.orders.settled]: true
    });
  }

  async function remove(id) {
    const record = await findRecord(id);
    await feishu.deleteRecord(tableId, record.record_id);
    return null;
  }

  return { list, createPreorder, ship, price, edit, bill, settle, remove };
}

async function applyBatchUpdates(feishu, tableId, records, fields) {
  const orders = [];
  const reasons = [];
  for (const record of records) {
    try {
      orders.push(orderFromFeishu(await feishu.updateRecord(tableId, record.record_id, fields)));
    } catch (error) {
      if (!(error instanceof FeishuError)) throw error;
      reasons.push({
        id: record.fields?.[FIELDS.orders.id] ?? '',
        reason: '飞书更新失败'
      });
    }
  }
  return batchResult(orders, reasons);
}

function batchResult(orders, reasons = []) {
  const totalAmount = orders.reduce((sum, order) => sum + order.amount, 0);
  return {
    count: orders.length,
    totalAmount: Number(totalAmount.toFixed(2)),
    orders,
    successCount: orders.length,
    skippedCount: reasons.length,
    reasons
  };
}
