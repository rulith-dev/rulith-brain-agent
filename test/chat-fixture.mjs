// In-memory fetch for Agent chat tests. The app-only status probe is denied.
export function chatFixture() {
  const requests = [];
  const server = 'http://brain.invalid';
  async function fetch(url, init = {}) {
    const method = init.method ?? 'GET';
    if (method === 'GET' && url === server + '/v1/memory/status') {
      return new Response(null, { status: 403 });
    }
    if (method !== 'POST' || url !== server + '/v1/brain/chat/completions') {
      throw new Error(`Unexpected request: ${method} ${url}`);
    }
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Fixture answer' } }] });
  }
  return { server, fetch, requests };
}
