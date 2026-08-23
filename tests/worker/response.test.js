import { describe, expect, it } from 'vitest';
import {
  corsHeaders,
  errorResponse,
  failure,
  jsonResponse,
  success
} from '../../worker/response.js';

describe('response helpers', () => {
  it('adds the request origin only when it is explicitly allowed', () => {
    const allowed = corsHeaders('https://allowed.example', ['https://allowed.example']);
    const denied = corsHeaders('https://denied.example', ['https://allowed.example']);

    expect(allowed).toEqual({
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin',
      'Access-Control-Allow-Origin': 'https://allowed.example'
    });
    expect(denied).toEqual({
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin'
    });
  });

  it('returns UTF-8 JSON without adding CORS by default', async () => {
    const response = jsonResponse({ ok: true }, 201);

    expect(response.status).toBe(201);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('builds the documented success and failure envelopes', async () => {
    const successResponse = success({ id: 'rec1' });
    const failureResponse = failure(409, '状态冲突', {}, { current: 'settled' });
    const compatibleError = errorResponse('Method Not Allowed', 405);

    await expect(successResponse.json()).resolves.toEqual({
      code: 0,
      message: 'success',
      data: { id: 'rec1' }
    });
    await expect(failureResponse.json()).resolves.toEqual({
      code: 409,
      message: '状态冲突',
      data: { current: 'settled' }
    });
    await expect(compatibleError.json()).resolves.toEqual({
      code: 405,
      message: 'Method Not Allowed',
      data: null
    });
    expect(compatibleError.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
