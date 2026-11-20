/**
 * App Builder Web Action: `get-brand-checks`
 *
 * 1. Returns the full list of all 13 Experience Context brands and their compiled
 *    Gemini Decisions API check sets.
 * 2. Persists and returns the user's last selected brand(s) (`selectedBrandIds` & `multiBrandMode`)
 *    in `@adobe/aio-lib-state` so the selection is remembered reliably across modal/panel sessions
 *    even when third-party iframe localStorage is partitioned or cleared by the browser.
 */

const stateLib = require('@adobe/aio-lib-state');
const { allBrandsCatalog, resolveBrandConfig } = require('../shared/gemini-decisions');

const PREFS_STATE_KEY = 'brandcheck_user_prefs_v1';

async function readServerPrefs() {
  try {
    const state = await stateLib.init();
    const res = await state.get(PREFS_STATE_KEY);
    return res && res.value ? JSON.parse(res.value) : null;
  } catch (_) {
    return null;
  }
}

async function writeServerPrefs(prefs) {
  try {
    const state = await stateLib.init();
    await state.put(PREFS_STATE_KEY, JSON.stringify(prefs), { ttl: 86400 * 365 });
    return true;
  } catch (_) {
    return false;
  }
}

async function main(params) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-gw-ims-org-id, x-api-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (params.__ow_method && params.__ow_method.toUpperCase() === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: {} };
  }

  // Save preferences operation
  if (params.operation === 'savePrefs' && Array.isArray(params.selectedBrandIds)) {
    const prefs = {
      selectedBrandIds: params.selectedBrandIds,
      multiBrandMode: Boolean(params.multiBrandMode),
      updatedAt: new Date().toISOString()
    };
    const saved = await writeServerPrefs(prefs);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: { success: true, saved, prefs }
    };
  }

  const { brandId } = params;
  if (brandId) {
    const brandConf = resolveBrandConfig(brandId);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: {
        success: true,
        brand_id: brandConf.brand_id,
        brand_name: brandConf.brand_name,
        stats: brandConf.stats,
        checks: brandConf.checks
      }
    };
  }

  const savedPrefs = await readServerPrefs();

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: {
      success: true,
      default_brand_id: allBrandsCatalog.default_brand_id,
      saved_prefs: savedPrefs,
      brands: allBrandsCatalog.brands_summary
    }
  };
}

exports.main = main;
