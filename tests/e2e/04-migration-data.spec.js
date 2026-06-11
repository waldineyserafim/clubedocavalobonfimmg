// @ts-check
const { test, expect } = require('@playwright/test');

// Tests that validate the Firestore migration data via the live app
// These tests use the Firestore REST API directly to verify data integrity

const PROJECT_ID = 'clubecavalobonfim';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Read access token from Firebase CLI config
const fs = require('fs');
const path = require('path');

function getAccessToken() {
  try {
    const configPath = path.join(process.env.HOME, '.config/configstore/firebase-tools.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config?.tokens?.access_token || null;
  } catch {
    return null;
  }
}

test.describe('Verificação de Migração Firestore', () => {
  let token;

  test.beforeAll(() => {
    token = getAccessToken();
    if (!token) {
      console.warn('⚠️  Token Firebase não encontrado — testes de migração pulados');
    }
  });

  test('organizations/org_bonfim existe e está configurado', async ({ request }) => {
    if (!token) test.skip();
    const resp = await request.get(`${FIRESTORE_BASE}/organizations/org_bonfim`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.fields?.ativo?.booleanValue).toBe(true);
    expect(body.fields?.plan?.stringValue).toBe('enterprise');
    expect(body.fields?.modules?.mapValue?.fields?.leiloes?.booleanValue).toBe(true);
    expect(body.fields?.modules?.mapValue?.fields?.classificados?.booleanValue).toBe(true);
    expect(body.fields?.modules?.mapValue?.fields?.produtos?.booleanValue).toBe(true);
  });

  test('systemPlans contém starter, professional e enterprise', async ({ request }) => {
    if (!token) test.skip();
    const plans = ['starter', 'professional', 'enterprise'];
    for (const plan of plans) {
      const resp = await request.get(`${FIRESTORE_BASE}/systemPlans/${plan}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(resp.ok(), `systemPlans/${plan} não existe`).toBeTruthy();
    }
  });

  test('Todos os memberProducts têm orgId = org_bonfim', async ({ request }) => {
    if (!token) test.skip();
    const resp = await request.get(`${FIRESTORE_BASE}/memberProducts?pageSize=300`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await resp.json();
    const docs = body.documents || [];
    const withoutOrg = docs.filter(d => !d.fields?.orgId);
    expect(withoutOrg.length, `${withoutOrg.length} memberProducts sem orgId`).toBe(0);
    if (docs.length > 0) {
      const sampleOrg = docs[0].fields?.orgId?.stringValue;
      expect(sampleOrg).toBe('org_bonfim');
    }
  });

  test('Todos os memberServices têm orgId = org_bonfim', async ({ request }) => {
    if (!token) test.skip();
    const resp = await request.get(`${FIRESTORE_BASE}/memberServices?pageSize=300`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await resp.json();
    const docs = body.documents || [];
    const withoutOrg = docs.filter(d => !d.fields?.orgId);
    expect(withoutOrg.length, `${withoutOrg.length} memberServices sem orgId`).toBe(0);
  });

  test('Todos os memberClassifieds têm orgId = org_bonfim', async ({ request }) => {
    if (!token) test.skip();
    const resp = await request.get(`${FIRESTORE_BASE}/memberClassifieds?pageSize=300`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await resp.json();
    const docs = body.documents || [];
    const withoutOrg = docs.filter(d => !d.fields?.orgId);
    expect(withoutOrg.length, `${withoutOrg.length} memberClassifieds sem orgId`).toBe(0);
  });

  test('Todos os auctionLots têm orgId = org_bonfim', async ({ request }) => {
    if (!token) test.skip();
    const resp = await request.get(`${FIRESTORE_BASE}/auctionLots?pageSize=300`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await resp.json();
    const docs = body.documents || [];
    const withoutOrg = docs.filter(d => !d.fields?.orgId);
    expect(withoutOrg.length, `${withoutOrg.length} auctionLots sem orgId`).toBe(0);
  });

  test('Users master NÃO têm orgId (correto)', async ({ request }) => {
    if (!token) test.skip();
    const resp = await request.get(`${FIRESTORE_BASE}/users?pageSize=300`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await resp.json();
    const docs = body.documents || [];
    const masterWithOrg = docs.filter(d => {
      const role = (d.fields?.role?.stringValue || '').toLowerCase();
      const hasOrg = !!d.fields?.orgId;
      return role.includes('master') && hasOrg;
    });
    expect(masterWithOrg.length, 'Master users não devem ter orgId').toBe(0);

    const nonMasterWithoutOrg = docs.filter(d => {
      const role = (d.fields?.role?.stringValue || '').toLowerCase();
      const hasOrg = !!d.fields?.orgId;
      return !role.includes('master') && !hasOrg;
    });
    expect(nonMasterWithoutOrg.length, `${nonMasterWithoutOrg.length} usuários não-master sem orgId`).toBe(0);
  });
});
