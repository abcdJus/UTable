const BACKEND_ORIGIN = (process.env.NETLIFY_BACKEND_ORIGIN || '').replace(/\/+$/, '');

function buildForwardHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete('accept-encoding');
  headers.delete('content-length');
  headers.delete('host');
  headers.delete('x-forwarded-for');
  headers.delete('x-forwarded-host');
  headers.delete('x-forwarded-proto');
  return headers;
}

async function proxyToBackend(request) {
  if (!BACKEND_ORIGIN) {
    return new Response(
      JSON.stringify({
        error: 'NETLIFY_BACKEND_ORIGIN is not configured.',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`${BACKEND_ORIGIN}${incomingUrl.pathname}${incomingUrl.search}`);
  const method = request.method.toUpperCase();
  const init = {
    method,
    headers: buildForwardHeaders(request),
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(method)) {
    init.body = await request.arrayBuffer();
  }

  const upstreamResponse = await fetch(targetUrl, init);
  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete('connection');
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  responseHeaders.delete('transfer-encoding');
  const responseBody = method === 'HEAD' ? null : await upstreamResponse.arrayBuffer();

  return new Response(responseBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

export default async (request) => proxyToBackend(request);

export const config = {
  path: ['/', '/health', '/login', '/register', '/index', '/logout', '/api/*'],
};
