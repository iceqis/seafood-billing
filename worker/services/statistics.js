import { orderFromFeishu, purchaseFromFeishu } from '../field-mappers.js';
import { ValidationError } from '../validation.js';

function round(value) {
  return Number(value.toFixed(2));
}

function isSale(order) {
  return order.status === 'unsettled' || order.status === 'settled';
}

export function buildYearTrend(orders, purchases, date) {
  const year = date.substring(0, 4);
  const monthCount = Number(date.substring(5, 7));
  const trend = Array.from({ length: monthCount }, (_, index) => ({
    month: `${year}-${String(index + 1).padStart(2, '0')}`,
    sales: 0,
    purchases: 0
  }));
  const byMonth = new Map(trend.map((entry) => [entry.month, entry]));

  for (const order of orders) {
    const entry = byMonth.get(order.date.substring(0, 7));
    if (entry && isSale(order)) entry.sales += order.amount;
  }
  for (const purchase of purchases) {
    const entry = byMonth.get(purchase.date.substring(0, 7));
    if (entry) entry.purchases += purchase.amount;
  }

  return trend.map((entry) => ({
    ...entry,
    sales: round(entry.sales),
    purchases: round(entry.purchases)
  }));
}

export function createStatisticsService(feishu, env) {
  async function load() {
    const orders = (await feishu.listAllRecords(env.TABLE_ORDERS)).map(orderFromFeishu);
    const purchases = (await feishu.listAllRecords(env.TABLE_PURCHASES)).map(purchaseFromFeishu);
    return { orders, purchases };
  }

  async function home(date) {
    const { orders, purchases } = await load();
    const month = date.substring(0, 7);
    const todayOrders = orders.filter((order) => order.date === date && isSale(order));
    const todayPurchases = purchases.filter((purchase) => purchase.date === date);
    const monthOrders = orders.filter((order) => order.date.startsWith(month) && isSale(order));
    return {
      todaySales: round(todayOrders.reduce((sum, order) => sum + order.amount, 0)),
      todayDealCount: todayOrders.length,
      todayPurchase: round(todayPurchases.reduce((sum, purchase) => sum + purchase.amount, 0)),
      monthSales: round(monthOrders.reduce((sum, order) => sum + order.amount, 0)),
      yearTrend: buildYearTrend(orders, purchases, date)
    };
  }

  async function details(type, date) {
    const { orders, purchases } = await load();
    const month = date.substring(0, 7);
    let items;
    let total;
    switch (type) {
      case 'today-sales':
        items = orders.filter((order) => order.date === date && isSale(order));
        total = items.reduce((sum, order) => sum + order.amount, 0);
        break;
      case 'today-deals':
        items = orders.filter((order) => order.date === date && isSale(order));
        total = items.length;
        break;
      case 'today-purchase':
        items = purchases.filter((purchase) => purchase.date === date);
        total = items.reduce((sum, purchase) => sum + purchase.amount, 0);
        break;
      case 'month-sales':
        items = orders.filter((order) => order.date.startsWith(month) && isSale(order));
        total = items.reduce((sum, order) => sum + order.amount, 0);
        break;
      default:
        throw new ValidationError('未知明细类型');
    }
    return { count: items.length, total: round(total), items };
  }

  return { home, details };
}
