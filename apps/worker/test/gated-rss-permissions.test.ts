import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DESCRIPTION_MODEL_TOKENS,
  DESCRIPTION_RETAIN_TOKENS,
  DERIVED_RETAIN_TOKENS,
  evaluateSourcePermissions,
  PUBLIC_DISPLAY_TOKENS,
  TITLE_MODEL_TOKENS,
  TITLE_RETAIN_TOKENS,
  type RegistryPermissionRow,
} from '../src/layers/l1-data-knowledge/news-triage.js';

// WJ-INT-02B explicit permission vocabulary (ADR-005).

const NOW = '2026-10-01T00:00:00.000Z';

function baseRow(): RegistryPermissionRow {
  return {
    approval_status: 'approved',
    auto_acquisition_enabled: true,
    registry_status: 'active',
    reuse_basis: null,
    reuse_license_url: null,
    reuse_scope: null,
    reuse_reviewer: null,
    reuse_reviewed_at: null,
    reuse_expires_at: null,
  };
}

describe('evaluateSourcePermissions', () => {
  it('denies everything when acquisition is not approved', () => {
    const permissions = evaluateSourcePermissions(
      {
        ...baseRow(),
        approval_status: 'pending',
        reuse_basis: ['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived', 'public_display'],
      },
      NOW,
    );
    assert.equal(permissions.acquisition, false);
    assert.equal(permissions.titleModel, false);
    assert.equal(permissions.descriptionRetention, false);
  });

  it('grants the full explicit vocabulary without license evidence', () => {
    const permissions = evaluateSourcePermissions(
      {
        ...baseRow(),
        reuse_basis: ['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived', 'public_display'],
      },
      NOW,
    );
    assert.deepEqual(permissions, {
      acquisition: true,
      titleModel: true,
      descriptionModel: true,
      titleRetention: true,
      descriptionRetention: true,
      derivedRetention: true,
      publicDisplay: true,
    });
  });

  it('denies every model/retention capability for bare public without license evidence', () => {
    const permissions = evaluateSourcePermissions({ ...baseRow(), reuse_basis: ['public'] }, NOW);
    assert.equal(permissions.acquisition, true);
    assert.equal(permissions.titleModel, false);
    assert.equal(permissions.descriptionModel, false);
    assert.equal(permissions.titleRetention, false);
    assert.equal(permissions.descriptionRetention, false);
    assert.equal(permissions.derivedRetention, false);
    assert.equal(permissions.publicDisplay, false);
  });

  it('denies every model/retention capability for bare open_access without license evidence', () => {
    const permissions = evaluateSourcePermissions({ ...baseRow(), reuse_basis: ['open_access'] }, NOW);
    assert.equal(permissions.titleModel, false);
    assert.equal(permissions.descriptionModel, false);
    assert.equal(permissions.titleRetention, false);
    assert.equal(permissions.descriptionRetention, false);
    assert.equal(permissions.derivedRetention, false);
    assert.equal(permissions.publicDisplay, false);
  });

  it('grants legacy-basis capabilities only with fresh reviewer license evidence', () => {
    const licensed: RegistryPermissionRow = {
      ...baseRow(),
      reuse_basis: ['public', 'open_access'],
      reuse_license_url: 'https://example.test/license/antaranews',
      reuse_scope: 'source-antara-metro model and retention grant',
      reuse_reviewer: 'registrar-1',
      reuse_reviewed_at: '2026-06-01T00:00:00.000Z',
      reuse_expires_at: null,
    };
    const permissions = evaluateSourcePermissions(licensed, NOW, 'source-antara-metro');
    assert.equal(permissions.titleModel, true);
    assert.equal(permissions.descriptionModel, true);
    assert.equal(permissions.titleRetention, true);
    assert.equal(permissions.descriptionRetention, true);
    assert.equal(permissions.derivedRetention, true);
    assert.equal(permissions.publicDisplay, true);
  });

  it('denies legacy-basis capabilities when the license binds a different source', () => {
    const licensed: RegistryPermissionRow = {
      ...baseRow(),
      reuse_basis: ['public'],
      reuse_license_url: 'https://example.test/license/antaranews',
      reuse_scope: 'source-antara-metro model and retention grant',
      reuse_reviewer: 'registrar-1',
      reuse_reviewed_at: '2026-06-01T00:00:00.000Z',
      reuse_expires_at: null,
    };
    assert.equal(evaluateSourcePermissions(licensed, NOW, 'source-detik-news').titleModel, false);
  });
  it('fails legacy-basis capabilities closed on stale, expired, or missing evidence', () => {
    const stale: RegistryPermissionRow = {
      ...baseRow(),
      reuse_basis: ['public'],
      reuse_license_url: 'https://example.test/license/x',
      reuse_scope: 'scope',
      reuse_reviewer: 'registrar-1',
      reuse_reviewed_at: '2024-01-01T00:00:00.000Z',
      reuse_expires_at: null,
    };
    assert.equal(evaluateSourcePermissions(stale, NOW).titleModel, false);

    const expired: RegistryPermissionRow = {
      ...baseRow(),
      reuse_basis: ['public'],
      reuse_license_url: 'https://example.test/license/x',
      reuse_scope: 'scope',
      reuse_reviewer: 'registrar-1',
      reuse_reviewed_at: '2026-06-01T00:00:00.000Z',
      reuse_expires_at: '2026-07-01T00:00:00.000Z',
    };
    assert.equal(evaluateSourcePermissions(expired, NOW).titleModel, false);

    const anonymous: RegistryPermissionRow = {
      ...baseRow(),
      reuse_basis: ['open_access'],
      reuse_license_url: 'https://example.test/license/x',
      reuse_scope: 'scope',
      reuse_reviewer: '',
      reuse_reviewed_at: '2026-06-01T00:00:00.000Z',
      reuse_expires_at: null,
    };
    assert.equal(evaluateSourcePermissions(anonymous, NOW).titleModel, false);
  });

  it('grants capabilities independently per explicit token', () => {
    const permissions = evaluateSourcePermissions(
      { ...baseRow(), reuse_basis: ['model_triage'] },
      NOW,
    );
    assert.equal(permissions.titleModel, true);
    assert.equal(permissions.descriptionModel, false);
    assert.equal(permissions.titleRetention, false);
    assert.equal(permissions.descriptionRetention, false);
  });

  it('never treats a bare public URL token as any explicit capability', () => {
    for (const set of [
      TITLE_MODEL_TOKENS,
      DESCRIPTION_MODEL_TOKENS,
      TITLE_RETAIN_TOKENS,
      DESCRIPTION_RETAIN_TOKENS,
      DERIVED_RETAIN_TOKENS,
      PUBLIC_DISPLAY_TOKENS,
    ]) {
      assert.equal(set.has('public'), false);
      assert.equal(set.has('open_access'), false);
    }
  });
});
