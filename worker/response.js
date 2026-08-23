export function corsHeaders(origin, allowedOrigins) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function jsonResponse(data, status, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cors
    }
  });
}

export function success(data = null, cors = {}, status = 200) {
  return jsonResponse({ code: 0, message: 'success', data }, status, cors);
}

export function failure(status, message, cors = {}, details = null) {
  return jsonResponse({ code: status, message, data: details }, status, cors);
}

export function errorResponse(message, status = 500, cors = {}) {
  return failure(status, message, cors);
}
