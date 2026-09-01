import { describe, expect, it, vi } from 'vitest';
import { FeishuError, createFeishuClient } from '../../worker/feishu-client.js';

const env = {
  FEISHU_APP_ID: 'app',
  FEISHU_APP_SECRET: 'secret',
  FEISHU_BASE_TOKEN: 'base'
};

function response(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('Feishu client', () => {
  it('retries transient read failures and succeeds without repeating authentication', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 1254290, msg: 'temporary limit' }))
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockResolvedValueOnce(response({
        code: 0,
        data: { items: [{ record_id: 'recovered', fields: {} }], has_more: false }
      }));

    const records = await createFeishuClient(env, fetchMock, { sleepImpl })
      .listAllRecords('table');

    expect(records.map(({ record_id: id }) => id)).toEqual(['recovered']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/'))).toHaveLength(1);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient read permission failure', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    await expect(createFeishuClient(env, fetchMock, { sleepImpl }).listAllRecords('table'))
      .rejects.toMatchObject({ message: '读取飞书数据失败', upstreamStatus: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['authentication', (fetchMock) => createFeishuClient(env, fetchMock).getTenantToken(), [], '飞书认证失败'],
    ['read', (fetchMock) => createFeishuClient(env, fetchMock).listAllRecords('table'), [
      response({ code: 0, tenant_access_token: 'token', expire: 7200 })
    ], '读取飞书数据失败'],
    ['write', (fetchMock) => createFeishuClient(env, fetchMock).createRecord('table', {}), [
      response({ code: 0, tenant_access_token: 'token', expire: 7200 })
    ], '写入飞书数据失败']
  ])('normalizes %s network rejections without leaking the underlying error', async (
    _operation,
    invoke,
    successfulResponses,
    expectedMessage
  ) => {
    const fetchMock = vi.fn();
    for (const successfulResponse of successfulResponses) {
      fetchMock.mockResolvedValueOnce(successfulResponse);
    }
    fetchMock.mockRejectedValueOnce(new TypeError('socket failed with secret-token'));

    const error = await invoke(fetchMock).catch((caught) => caught);

    expect(error).toBeInstanceOf(FeishuError);
    expect(error).toMatchObject({ message: expectedMessage, status: 502 });
    expect(String(error)).not.toContain('secret-token');
  });

  it('normalizes response body read rejections', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockRejectedValue(new TypeError('body stream exposed secret-token'))
      });

    const error = await createFeishuClient(env, fetchMock)
      .listAllRecords('table')
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(FeishuError);
    expect(error).toMatchObject({ message: '读取飞书数据失败', status: 502 });
    expect(String(error)).not.toContain('secret-token');
  });

  it('reads every page and carries filter, page size, and page token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: { items: [{ record_id: '1', fields: {} }], has_more: true, page_token: 'next' }
      }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: { items: [{ record_id: '2', fields: {} }], has_more: false }
      }));
    const filter = { field_name: '状态', operator: 'is', value: ['未结算'] };

    const records = await createFeishuClient(env, fetchMock).listAllRecords('table', filter);

    expect(records.map((item) => item.record_id)).toEqual(['1', '2']);
    const firstUrl = new URL(fetchMock.mock.calls[1][0]);
    const secondUrl = new URL(fetchMock.mock.calls[2][0]);
    expect(firstUrl.searchParams.get('page_size')).toBe('500');
    expect(firstUrl.searchParams.get('filter')).toBe(JSON.stringify(filter));
    expect(secondUrl.searchParams.get('page_token')).toBe('next');
    expect(secondUrl.searchParams.get('filter')).toBe(JSON.stringify(filter));
  });

  it.each([
    ['missing', undefined],
    ['repeated', 'next']
  ])('rejects %s continuation tokens instead of truncating or looping', async (kind, nextToken) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: { items: [{ record_id: '1', fields: {} }], has_more: true, page_token: 'next' }
      }));
    if (kind === 'repeated') {
      fetchMock.mockResolvedValueOnce(response({
        code: 0,
        data: { items: [{ record_id: '2', fields: {} }], has_more: true, page_token: nextToken }
      }));
    } else {
      fetchMock.mockResolvedValueOnce(response({
        code: 0,
        data: { items: [{ record_id: '2', fields: {} }], has_more: true }
      }));
    }

    await expect(createFeishuClient(env, fetchMock).listAllRecords('table'))
      .rejects.toThrow('读取飞书数据分页失败');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('caches the tenant token for subsequent requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockImplementation(() => response({ code: 0, data: { items: [], has_more: false } }));
    const client = createFeishuClient(env, fetchMock);

    await client.listAllRecords('table');
    await client.listAllRecords('table');

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/'))).toHaveLength(1);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer token');
  });

  it('rejects token and read failures with useful errors', async () => {
    const tokenFailure = vi.fn().mockResolvedValue(response({ code: 999 }, { status: 200 }));
    await expect(createFeishuClient(env, tokenFailure).getTenantToken()).rejects.toThrow('飞书认证失败');

    const readFailure = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 999, msg: 'bad filter' }));
    await expect(createFeishuClient(env, readFailure).listAllRecords('table')).rejects.toThrow('读取飞书数据失败');
  });

  it('normalizes non-JSON auth, read, and write HTTP failures', async () => {
    const htmlFailure = () => new Response('<html>bad gateway</html>', { status: 502 });
    const authFailure = vi.fn().mockImplementation(htmlFailure);
    await expect(createFeishuClient(env, authFailure).getTenantToken()).rejects.toThrow('飞书认证失败');

    const readFailure = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockImplementationOnce(htmlFailure);
    await expect(createFeishuClient(env, readFailure).listAllRecords('table')).rejects.toThrow('读取飞书数据失败');

    const writeFailure = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockImplementationOnce(() => new Response('service unavailable', { status: 503 }));
    await expect(createFeishuClient(env, writeFailure).createRecord('table', {})).rejects.toThrow('写入飞书数据失败');
  });

  it('uses the expected create, update, and delete request contracts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { record: { record_id: 'created' } } }))
      .mockResolvedValueOnce(response({ code: 0, data: { record: { record_id: 'updated' } } }))
      .mockResolvedValueOnce(response({ code: 0, data: { deleted: true } }));
    const client = createFeishuClient(env, fetchMock);

    await expect(client.createRecord('table', { 名称: '虾' })).resolves.toEqual({ record_id: 'created' });
    await expect(client.updateRecord('table', 'rec1', { 价格: 40 })).resolves.toEqual({ record_id: 'updated' });
    await expect(client.deleteRecord('table', 'rec1')).resolves.toEqual({ deleted: true });

    const [, create, update, del] = fetchMock.mock.calls;
    expect(create[1].method).toBe('POST');
    expect(JSON.parse(create[1].body)).toEqual({ fields: { 名称: '虾' } });
    expect(update[0]).toContain('/tables/table/records/rec1');
    expect(update[1].method).toBe('PUT');
    expect(JSON.parse(update[1].body)).toEqual({ fields: { 价格: 40 } });
    expect(del[0]).toContain('/tables/table/records/rec1');
    expect(del[1].method).toBe('DELETE');
    expect(del[1].body).toBeUndefined();
  });

  it('accepts an empty successful DELETE response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(createFeishuClient(env, fetchMock).deleteRecord('table', 'rec1')).resolves.toBeNull();
  });

  it('rejects write failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 500, msg: 'write failed' }));

    await expect(createFeishuClient(env, fetchMock).createRecord('table', {})).rejects.toThrow('写入飞书数据失败');
  });

  it('preserves a safe HTTP 409 marker for document conflict handling', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 999 }, { status: 409 }));

    const error = await createFeishuClient(env, fetchMock)
      .createRecord('table', {})
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(FeishuError);
    expect(error).toMatchObject({
      message: '写入飞书数据失败',
      status: 502,
      upstreamStatus: 409
    });
  });
});
