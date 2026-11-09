import { getDecryptedApiKey } from '../../Utils/encryption.js';
import { pool } from '../../db.js';

const CLOUDFLARE_ACCOUNT_ID = 'b2f6fd6d7713fffb55abdbe86ce84e37';
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

async function cfHeaders() {
  const token = await getDecryptedApiKey('cloudflare_api_token');
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

// Creates a new zone (adds a domain to Cloudflare) and returns the real, unique nameservers Cloudflare assigns to it
export async function createZone(domainName) {
  const headers = await cfHeaders();

  const response = await fetch(`${CLOUDFLARE_API}/zones`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: domainName,
      account: { id: CLOUDFLARE_ACCOUNT_ID },
      type: 'full'
    })
  });

  const data = await response.json();

  if (!data.success) {
    // If the zone already exists (common if retrying), fetch it instead of failing
    const alreadyExists = data.errors?.some((e) => e.code === 1061);
    if (alreadyExists) {
      return getZoneByName(domainName);
    }
    throw new Error(`Cloudflare zone creation failed: ${JSON.stringify(data.errors)}`);
  }

  return {
    zoneId: data.result.id,
    nameservers: data.result.name_servers,
    status: data.result.status
  };
}

export async function getZoneByName(domainName) {
  const headers = await cfHeaders();
  const response = await fetch(`${CLOUDFLARE_API}/zones?name=${encodeURIComponent(domainName)}`, { headers });
  const data = await response.json();

  if (!data.success || data.result.length === 0) {
    throw new Error(`Could not find existing Cloudflare zone for ${domainName}`);
  }

  const zone = data.result[0];
  return { zoneId: zone.id, nameservers: zone.name_servers, status: zone.status };
}

// Checks whether the domain's nameservers have actually been switched to Cloudflare yet (only relevant for externally-owned domains)
export async function checkZoneStatus(zoneId) {
  const headers = await cfHeaders();
  const response = await fetch(`${CLOUDFLARE_API}/zones/${zoneId}`, { headers });
  const data = await response.json();
  if (!data.success) throw new Error(`Could not check zone status: ${JSON.stringify(data.errors)}`);
  return data.result.status; // 'pending' or 'active'
}

// Adds the actual A record pointing the domain at your hosting server
export async function createHostingRecord(zoneId, domainName) {
  const headers = await cfHeaders();

  const settingResult = await pool.query(`SELECT value FROM platform_settings WHERE key = 'hosting_target_ip'`);
  const targetIp = settingResult.rows[0]?.value;
  if (!targetIp) throw new Error('No hosting_target_ip configured in platform_settings');

  const response = await fetch(`${CLOUDFLARE_API}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'A',
      name: domainName,
      content: targetIp,
      proxied: true,
      ttl: 1
    })
  });

  const data = await response.json();
  if (!data.success) {
    const alreadyExists = data.errors?.some((e) => e.code === 81057);
    if (alreadyExists) return { success: true, alreadyExisted: true };
    throw new Error(`Could not create DNS record: ${JSON.stringify(data.errors)}`);
  }

  // Also add the www subdomain, pointing at the same place
  await fetch(`${CLOUDFLARE_API}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'A', name: `www.${domainName}`, content: targetIp, proxied: true, ttl: 1 })
  }).catch(() => {}); // best-effort, don't fail the whole thing if www already exists

  return { success: true };
}