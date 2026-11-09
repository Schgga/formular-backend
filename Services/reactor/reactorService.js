import { createReactorToken } from './reactorClient.js';

export async function getReactorSessionToken() {
  const { jwt, expiresAt } = await createReactorToken();
  return { jwt, expiresAt };
}