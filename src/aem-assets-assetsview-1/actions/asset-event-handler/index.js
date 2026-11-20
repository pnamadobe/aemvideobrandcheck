/**
 * App Builder Non-Web Event Action: `asset-event-handler`
 *
 * Triggered automatically by the AEM Assets I/O Event `Asset Processing Completed`.
 * Filters for video/* assets, runs the CVS Gemini Decisions evaluation, caches the report,
 * and writes the governance verdict back to AEM asset metadata.
 */

const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');
const { evaluateVideoAgainstBrand } = require('../shared/gemini-decisions');
const {
  fetchVideoBinaryFromAem,
  writeEvaluationToAssetMetadata
} = require('../shared/aem-client');

async function main(params) {
  const logger = Core.Logger('asset-event-handler', { level: params.LOG_LEVEL || 'info' });

  // Handle Adobe I/O Events webhook challenge if invoked directly
  if (params.challenge) {
    return { statusCode: 200, body: { challenge: params.challenge } };
  }

  const eventObj = params.event || params.data || params;
  const assetFormat =
    eventObj['dc:format'] ||
    eventObj.mimeType ||
    eventObj?.assetMetadata?.['dc:format'] ||
    '';
  const assetPath = eventObj.assetPath || eventObj.path || eventObj['repo:path'] || '';
  const assetId = eventObj.assetId || eventObj.id || '';
  const aemHost = eventObj.repositoryId || params.DEFAULT_AEM_HOST || '';

  if (
    !assetFormat.startsWith('video/') &&
    !/\.(mp4|mov|webm|m4v|avi)$/i.test(assetPath)
  ) {
    logger.info(`Skipping non-video asset event: ${assetPath} (${assetFormat})`);
    return {
      statusCode: 200,
      body: { skipped: true, reason: 'Not a video asset', assetPath, assetFormat }
    };
  }

  const apiKey = params.GEMINI_API_KEY;
  const accessToken = params.AEM_SERVICE_TOKEN || params.accessToken;

  if (!apiKey || !accessToken || !aemHost) {
    logger.warn('Missing GEMINI_API_KEY, AEM_SERVICE_TOKEN, or aemHost for background event');
    return {
      statusCode: 202,
      body: { skipped: true, reason: 'Missing credentials for background run' }
    };
  }

  const fetched = await fetchVideoBinaryFromAem({
    aemHost,
    assetId,
    assetPath,
    accessToken
  });

  const report = await evaluateVideoAgainstBrand({
    videoBuffer: fetched.buffer,
    mimeType: fetched.mimeType,
    assetName: assetPath.split('/').pop() || 'video.mp4',
    assetPath,
    assetId,
    resolution: 'low',
    includeExplanations: true,
    apiKey
  });

  if (assetId) {
    report.metadataWrite = await writeEvaluationToAssetMetadata({
      aemHost,
      assetId,
      evaluationResult: report,
      accessToken
    });
  }

  try {
    const state = await stateLib.init();
    const cacheKey = `brandcheck_${(assetId || assetPath).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    await state.put(cacheKey, JSON.stringify(report), { ttl: 86400 * 7 });
  } catch (_) {}

  return {
    statusCode: 200,
    body: {
      success: true,
      assetId,
      assetPath,
      overall_aligned: report.overall_aligned,
      compliance_score: report.compliance_score
    }
  };
}

exports.main = main;
