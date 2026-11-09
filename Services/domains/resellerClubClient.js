import { getDecryptedApiKey } from '../../Utils/encryption.js';

const CHECK_API_URL = 'https://domaincheck.httpapi.com/api';
const CUSTOMER_API_URL = 'https://httpapi.com/api';

export async function checkDomainAvailability(domainName, tlds = ['com', 'net', 'org', 'io']) {
  const resellerId = await getDecryptedApiKey('resellerclub_reseller_id');
  const apiKey = await getDecryptedApiKey('resellerclub_api_key');

  const params = new URLSearchParams({
    'auth-userid': resellerId,
    'api-key': apiKey,
    'domain-name': domainName
  });

  tlds.forEach((tld) => params.append('tlds', tld));

  const response = await fetch(`${CHECK_API_URL}/domains/available.json?${params.toString()}`);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ResellerClub error: ${response.status} - ${errText}`);
  }

  return response.json();
}

export async function getCustomerByEmail(email) {
  const resellerId = await getDecryptedApiKey('resellerclub_reseller_id');
  const apiKey = await getDecryptedApiKey('resellerclub_api_key');

  const params = new URLSearchParams({
    'auth-userid': resellerId,
    'api-key': apiKey,
    username: email
  });

  const response = await fetch(`${CUSTOMER_API_URL}/customers/details.json?${params.toString()}`);
  const data = await response.json();

  if (!data || data.status === 'ERROR' || !data.customerid) {
    return null;
  }

  return data.customerid;
}

export async function createCustomer({ email, password, name, company, addressLine1, city, state, country, zipcode, phoneCc, phone }) {
  const resellerId = await getDecryptedApiKey('resellerclub_reseller_id');
  const apiKey = await getDecryptedApiKey('resellerclub_api_key');

  const params = new URLSearchParams({
    'auth-userid': resellerId,
    'api-key': apiKey,
    username: email,
    passwd: password,
    name,
    company: company || name,
    'address-line-1': addressLine1,
    city,
    state,
    country,
    zipcode,
    'phone-cc': phoneCc,
    phone,
    'lang-pref': 'en'
  });

  const response = await fetch(`${CUSTOMER_API_URL}/customers/v2/signup.json?${params.toString()}`, {
    method: 'POST'
  });

  const data = await response.json();
  if (data.status === 'ERROR') {
    throw new Error(data.message || 'Could not create customer');
  }

  return data;
}

export async function getDefaultContact(customerId) {
  const resellerId = await getDecryptedApiKey('resellerclub_reseller_id');
  const apiKey = await getDecryptedApiKey('resellerclub_api_key');

  const params = new URLSearchParams({
    'auth-userid': resellerId,
    'api-key': apiKey,
    'customer-id': customerId,
    type: 'Contact'
  });

  const response = await fetch(`${CUSTOMER_API_URL}/contacts/default.json?${params.toString()}`, {
    method: 'POST'
  });
  const data = await response.json();

  if (!data || data.status === 'ERROR') {
    throw new Error(data?.message || 'Could not fetch default contact');
  }

  const contactId = data.Contact?.registrant;

  if (!contactId) {
    throw new Error(`Could not determine contact ID from response: ${JSON.stringify(data)}`);
  }

  return contactId;
}

export async function registerDomain({ domainName, years, nameservers, customerId, contactId }) {
  const resellerId = await getDecryptedApiKey('resellerclub_reseller_id');
  const apiKey = await getDecryptedApiKey('resellerclub_api_key');

  const params = new URLSearchParams({
    'auth-userid': resellerId,
    'api-key': apiKey,
    'domain-name': domainName,
    years: String(years),
    'customer-id': String(customerId),
    'reg-contact-id': String(contactId),
    'admin-contact-id': String(contactId),
    'tech-contact-id': String(contactId),
    'billing-contact-id': String(contactId),
    'invoice-option': 'NoInvoice',
    'protect-privacy': 'true'
  });

  nameservers.forEach((ns) => params.append('ns', ns));

  const response = await fetch(`${CUSTOMER_API_URL}/domains/register.json?${params.toString()}`, {
    method: 'POST'
  });

  const data = await response.json();
  if (data.status === 'ERROR') {
    throw new Error(data.message || 'Domain registration failed');
  }

  return data;
}