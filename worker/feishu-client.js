const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

export class FeishuError extends Error {
  constructor(message, { upstreamStatus } = {}) {
    super(message);
    this.name = 'FeishuError';
    this.status = 502;
    if (Number.isInteger(upstreamStatus)) this.upstreamStatus = upstreamStatus;
  }
}

export function createFeishuClient(env, fetchImpl = fetch) {
  let tokenCache = null;

  async function withFeishuError(errorMessage, operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof FeishuError) throw error;
      throw new FeishuError(errorMessage);
    }
  }

  async function readBody(response, errorMessage, allowEmpty = false) {
    return withFeishuError(errorMessage, async () => {
      if (!response.ok) {
        throw new FeishuError(errorMessage, { upstreamStatus: response.status });
      }
      const text = await response.text();
      if (!text.trim()) {
        if (allowEmpty) return null;
        throw new FeishuError(errorMessage);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new FeishuError(errorMessage);
      }
    });
  }

  async function getTenantToken() {
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt > now) return tokenCache.value;

    const response = await withFeishuError('飞书认证失败', () => fetchImpl(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: env.FEISHU_APP_ID,
        app_secret: env.FEISHU_APP_SECRET
      })
    }));
    const body = await readBody(response, '飞书认证失败');
    if (body.code !== 0) throw new FeishuError('飞书认证失败');

    const expire = Number(body.expire) || 3600;
    tokenCache = {
      value: body.tenant_access_token,
      expiresAt: now + Math.max(60, expire - 300) * 1000
    };
    return tokenCache.value;
  }

  function recordsUrl(tableId, recordId = '') {
    const suffix = recordId ? `/${recordId}` : '';
    return `${FEISHU_API_BASE}/bitable/v1/apps/${env.FEISHU_BASE_TOKEN}/tables/${tableId}/records${suffix}`;
  }

  async function listAllRecords(tableId, filter = null) {
    const items = [];
    let pageToken = '';
    const seenPageTokens = new Set();

    do {
      const url = new URL(recordsUrl(tableId));
      url.searchParams.set('page_size', '500');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      if (filter) url.searchParams.set('filter', JSON.stringify(filter));

      const response = await withFeishuError('读取飞书数据失败', async () => fetchImpl(url, {
        headers: { Authorization: `Bearer ${await getTenantToken()}` }
      }));
      const body = await readBody(response, '读取飞书数据失败');
      if (body.code !== 0) throw new FeishuError('读取飞书数据失败');

      items.push(...(body.data?.items ?? []));
      if (body.data?.has_more) {
        const nextPageToken = body.data.page_token;
        if (!nextPageToken || seenPageTokens.has(nextPageToken)) {
          throw new FeishuError('读取飞书数据分页失败');
        }
        seenPageTokens.add(nextPageToken);
        pageToken = nextPageToken;
      } else {
        pageToken = '';
      }
    } while (pageToken);

    return items;
  }

  async function checkTable(tableId) {
    const url = new URL(recordsUrl(tableId));
    url.searchParams.set('page_size', '1');
    const response = await withFeishuError('读取飞书数据失败', async () => fetchImpl(url, {
      headers: { Authorization: `Bearer ${await getTenantToken()}` }
    }));
    const body = await readBody(response, '读取飞书数据失败');
    if (body.code !== 0) throw new FeishuError('读取飞书数据失败');
    return true;
  }

  async function requestRecord(method, tableId, recordId = '', fields) {
    const response = await withFeishuError('写入飞书数据失败', async () => fetchImpl(recordsUrl(tableId, recordId), {
      method,
      headers: {
        Authorization: `Bearer ${await getTenantToken()}`,
        'Content-Type': 'application/json'
      },
      body: method === 'DELETE' ? undefined : JSON.stringify({ fields })
    }));
    const body = await readBody(response, '写入飞书数据失败', method === 'DELETE');
    if (body === null) return null;
    if (body.code !== 0) throw new FeishuError('写入飞书数据失败');
    return body.data?.record ?? body.data;
  }

  return {
    getTenantToken,
    listAllRecords,
    checkTable,
    createRecord: (tableId, fields) => requestRecord('POST', tableId, '', fields),
    updateRecord: (tableId, recordId, fields) => requestRecord('PUT', tableId, recordId, fields),
    deleteRecord: (tableId, recordId) => requestRecord('DELETE', tableId, recordId)
  };
}
