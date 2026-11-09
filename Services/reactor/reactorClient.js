import { getDecryptedApiKey } from '../../Utils/encryption.js';

const REACTOR_API_URL = 'https://api.reactor.inc';

export async function createReactorToken({ modelMatch = ['xmax/x2'] } = {}) {
  const apiKey = await getDecryptedApiKey('reactor_api_key');

  const response = await fetch(`${REACTOR_API_URL}/tokens`, {
    method: 'POST',
    headers: {
      'Reactor-API-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      authorization_details: [
        {
          type: 'session',
          resources: { models: { match: modelMatch } }
        }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Reactor token request failed: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  return { jwt: data.jwt, expiresAt: data.expires_at };
}