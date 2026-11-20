/**
 * App Builder Web Action: `evaluate-video`
 *
 * Evaluates an AEM video asset against Experience Context governance checks
 * using the Gemini Decisions API (`gemini-decision-1`), optionally writes the summary
 * back to AEM asset metadata, and caches the full report in App Builder State.
 */

const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');
const { evaluateVideoAgainstBrand } = require('../shared/gemini-decisions');
const {
  fetchVideoBinaryFromAem,
  writeEvaluationToAssetMetadata
} = require('../shared/aem-client');

async function getCachedReport(assetKey) {
  try {
    const state = await stateLib.init();
    const res = await state.get(assetKey);
    return res && res.value ? JSON.parse(res.value) : null;
  } catch (_) {
    return null;
  }
}

async function setCachedReport(assetKey, report) {
  try {
    const state = await stateLib.init();
    await state.put(assetKey, JSON.stringify(report), { ttl: 86400 * 7 });
  } catch (_) {
    // State storage is optional when running locally without credentials
  }
}

async function main(params) {
  const logger = Core.Logger('evaluate-video', { level: params.LOG_LEVEL || 'info' });

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-gw-ims-org-id, x-api-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (params.__ow_method && params.__ow_method.toUpperCase() === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: {} };
  }

  try {
    const {
      brandId,
      brandIds,
      assetId,
      assetPath,
      assetName,
      aemHost = params.DEFAULT_AEM_HOST,
      downloadUrl,
      videoUrl,
      aemApiKey,
      geminiApiKey,
      resolution = 'low',
      includeExplanations = true,
      writeMetadata = true,
      forceRefresh = false,
      checkCachedOnly = false
    } = params;

    let accessToken = params.accessToken;
    if (!accessToken && params.__ow_headers?.authorization) {
      accessToken = String(params.__ow_headers.authorization).replace(/^Bearer\s+/i, '').trim();
    }

    // Also persist the chosen brand(s) in App Builder State so the next modal/panel open remembers it
    const chosenList = Array.isArray(brandIds) && brandIds.length > 0
      ? brandIds
      : (brandId ? [brandId] : []);
    if (chosenList.length > 0) {
      try {
        const state = await stateLib.init();
        await state.put(
          'brandcheck_user_prefs_v1',
          JSON.stringify({
            selectedBrandIds: chosenList,
            multiBrandMode: chosenList.length > 1,
            updatedAt: new Date().toISOString()
          }),
          { ttl: 86400 * 365 }
        );
      } catch (_) {}
    }

    const brandScopeKey = Array.isArray(brandIds) && brandIds.length > 0
      ? brandIds.slice().sort().join('_')
      : (brandId || 'default');

    const cacheKey = `brandcheck_${brandScopeKey}_${(assetId || assetPath || videoUrl || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 200);

    if (!forceRefresh) {
      const cached = await getCachedReport(cacheKey);
      if (cached) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: { ...cached, cached: true }
        };
      }
    }

    if (checkCachedOnly) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: { success: true, cached: false, report: null }
      };
    }

    const effectiveGeminiKey = geminiApiKey || params.GEMINI_API_KEY;
    if (!effectiveGeminiKey) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: {
          success: false,
          error:
            'Missing Gemini API key. Provide geminiApiKey in the panel or configure GEMINI_API_KEY in App Builder action inputs.'
        }
      };
    }

    let videoBuffer = null;
    let resolvedVideoUrl = videoUrl || null;
    let mimeType = 'video/mp4';

    if (!resolvedVideoUrl) {
      const fetched = await fetchVideoBinaryFromAem({
        aemHost,
        assetId,
        assetPath,
        downloadUrl,
        accessToken,
        apiKey: aemApiKey
      });
      if (fetched.presignedUrl) {
        resolvedVideoUrl = fetched.presignedUrl;
      } else {
        videoBuffer = fetched.buffer;
      }
      mimeType = fetched.mimeType || 'video/mp4';
    }

    const report = await evaluateVideoAgainstBrand({
      brandId,
      brandIds,
      videoUri: resolvedVideoUrl,
      videoBuffer,
      mimeType,
      assetName: assetName || (assetPath ? assetPath.split('/').pop() : 'video.mp4'),
      assetPath: assetPath || '',
      assetId: assetId || '',
      resolution,
      includeExplanations: includeExplanations !== false,
      apiKey: effectiveGeminiKey
    });

    if (writeMetadata && aemHost && assetId && accessToken) {
      try {
        const metaPromise = writeEvaluationToAssetMetadata({
          aemHost,
          assetId,
          evaluationResult: report,
          accessToken,
          apiKey: aemApiKey
        });
        const timeoutPromise = new Promise(resolve =>
          setTimeout(() => resolve({ written: false, reason: 'Metadata write timed out' }), 8000)
        );
        report.metadataWrite = await Promise.race([metaPromise, timeoutPromise]);
      } catch (metaErr) {
        logger.warn(`Metadata write-back skipped: ${metaErr.message}`);
        report.metadataWrite = { written: false, error: metaErr.message };
      }
    }

    await setCachedReport(cacheKey, report);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: report
    };
  } catch (err) {
    logger.error(err);
    return {
      statusCode: err.isSafetyBlock ? 422 : 500,
      headers: corsHeaders,
      body: {
        success: false,
        error: err.message,
        code: err.code || 'INTERNAL_ERROR',
        needs_human_review: Boolean(err.isSafetyBlock)
      }
    };
  }
}

exports.main = main;
