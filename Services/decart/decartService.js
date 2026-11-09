import { getDecartClient } from './decartClient.js';

// Short-lived client token for the browser.
//  expiresIn            : how long the token can be used to START a session (seconds)
//  allowedModels        : e.g. ['lucy-2.5'] — the token cannot be used for any other model
//  allowedOrigins       : e.g. ['https://app.yoursite.com'] — the token only works from your site
//  maxSessionDuration   : Decart closes the live session after this many seconds (paid time)
export async function createRealtimeToken({ expiresIn = 60, allowedModels, allowedOrigins, maxSessionDuration } = {}) {
  const client = await getDecartClient();

  const token = await client.tokens.create({
    expiresIn,
    ...(allowedModels?.length && { allowedModels }),
    ...(allowedOrigins?.length && { allowedOrigins }),
    ...(maxSessionDuration && { constraints: { realtime: { maxSessionDuration: Math.max(10, Math.floor(maxSessionDuration)) } } }),
  });

  return token;
}