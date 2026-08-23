import { orderFromFeishu, purchaseFromFeishu } from '../field-mappers.js';
import { ValidationError } from '../validation.js';

function round(value) {
  return Number(value.toFixed(2));
}

function isSale(order) {
  return order.status === 'unsettled' || order.status === 'settled';
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
      monthSales: round(monthOrders.reduce((sum, order) => sum + order.amount, 0))
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
