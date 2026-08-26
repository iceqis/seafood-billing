const LOCAL_DEVELOPMENT_KEY = 'local-development';

export async function checkLoginRateLimit(request, env) {
  const key = request.headers.get('CF-Connecting-IP')?.trim() || LOCAL_DEVELOPMENT_KEY;
  try {
    if (typeof env.LOGIN_RATE_LIMITER?.limit !== 'function') {
      throw new Error('rate limiter binding unavailable');
    }
    const result = await env.LOGIN_RATE_LIMITER.limit({ key });
    return result?.success !== false;
  } catch {
    console.error({ event: 'login_rate_limiter_unavailable' });
    return true;
  }
}
