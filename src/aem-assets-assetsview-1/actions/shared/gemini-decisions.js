/**
 * Core evaluation engine for AEM Video Brand Check using the Gemini Decisions API (`gemini-decision-1`)
 * across ANY selected brand(s) in Experience Context, plus optional Gemini Flash rationale generation.
 */

const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

function loadJsonFallback(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) {}
  return fallback;
}

const defaultCompiled = loadJsonFallback(
  path.join(__dirname, 'cvs-compiled-questions.json'),
  { brand_id: 'default', brand_name: 'Default Brand', questions: {}, checks: [] }
);

const allBrandsCatalog = loadJsonFallback(
  path.join(__dirname, 'all-brands-compiled.json'),
  {
    default_brand_id: defaultCompiled.brand_id,
    brands_summary: [
      {
        brand_id: defaultCompiled.brand_id,
        brand_name: defaultCompiled.brand_name,
        total_checks: defaultCompiled.checks.length,
        video_checks: defaultCompiled.checks.length,
        questions_count: Object.keys(defaultCompiled.questions || {}).length
      }
    ],
    brands: { [defaultCompiled.brand_id]: defaultCompiled }
  }
);

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Resolves a brand definition by ID or case-insensitive name.
 */
function resolveBrandConfig(brandIdOrName) {
  if (!brandIdOrName) {
    return allBrandsCatalog.brands[allBrandsCatalog.default_brand_id] || defaultCompiled;
  }
  if (allBrandsCatalog.brands[brandIdOrName]) {
    return allBrandsCatalog.brands[brandIdOrName];
  }
  const needle = String(brandIdOrName).toLowerCase().trim();
  const match = Object.values(allBrandsCatalog.brands).find(
    b => b.brand_name.toLowerCase() === needle || b.brand_id.toLowerCase() === needle
  );
  return match || defaultCompiled;
}

/**
 * Uploads a video buffer to the Gemini Files API so videos of any size can be evaluated
 * and polls until the file state is ACTIVE.
 */
async function uploadVideoToGeminiFiles(videoBuffer, mimeType, displayName, apiKey) {
  const numBytes = videoBuffer.length;
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(numBytes),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file: { display_name: displayName || 'aem-video.mp4' }
      })
    }
  );

  if (!startRes.ok) {
    const errText = await startRes.text();
    throw new Error(`Gemini Files upload init failed (${startRes.status}): ${errText}`);
  }

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini Files API did not return x-goog-upload-url header');
  }

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: videoBuffer
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Gemini Files byte upload failed (${uploadRes.status}): ${errText}`);
  }

  const uploadText = await uploadRes.text();
  let uploadJson = {};
  try {
    uploadJson = uploadText ? JSON.parse(uploadText) : {};
  } catch (_) {
    throw new Error(`Gemini Files upload returned non-JSON: ${uploadText.slice(0, 200)}`);
  }
  let fileObj = uploadJson.file || uploadJson;

  const maxPolls = 30;
  for (let i = 0; i < maxPolls && fileObj.state === 'PROCESSING'; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(
      `${GEMINI_API_BASE}/${fileObj.name}?key=${encodeURIComponent(apiKey)}`
    );
    if (pollRes.ok) {
      const pollText = await pollRes.text();
      try {
        fileObj = JSON.parse(pollText);
      } catch (_) {}
    }
  }

  if (fileObj.state && fileObj.state !== 'ACTIVE') {
    throw new Error(`Gemini file processing ended in state: ${fileObj.state}`);
  }

  return {
    uri: fileObj.uri,
    name: fileObj.name,
    mimeType: fileObj.mimeType || mimeType
  };
}

/**
 * Calls POST https://generativelanguage.googleapis.com/v1beta/decisions
 * with `model: "gemini-decision-1"`, the video input block, and all compiled questions.
 */
async function callGeminiDecisionsApi({
  videoInputBlock,
  contextText,
  questions,
  apiKey
}) {
  const inputBlocks = [];
  if (contextText) {
    inputBlocks.push({ type: 'text', text: contextText + '\n' });
  }
  inputBlocks.push(videoInputBlock);

  const startedAt = Date.now();
  const res = await fetch(`${GEMINI_API_BASE}/decisions`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gemini-decision-1',
      input: inputBlocks,
      questions
    })
  });

  const latencyMs = Date.now() - startedAt;
  const rawBodyText = await res.text();
  let body = {};
  try {
    body = rawBodyText ? JSON.parse(rawBodyText) : {};
  } catch (_) {
    throw new Error(`Gemini Decisions API returned non-JSON (HTTP ${res.status}): ${rawBodyText.slice(0, 200)}`);
  }

  if (!res.ok || body.error) {
    const errCode = body.error?.code || `HTTP_${res.status}`;
    const errMsg = body.error?.message || JSON.stringify(body);
    const err = new Error(`Gemini Decisions API error (${errCode}): ${errMsg}`);
    err.code = errCode;
    err.isSafetyBlock = [
      'safety',
      'prohibited_content',
      'blocklist',
      'image_safety',
      'content_blocked'
    ].includes(errCode);
    throw err;
  }

  return {
    answers: body.answers || {},
    usage: body.usage || {},
    latencyMs
  };
}

/**
 * Evaluates a single compiled check against the returned Decisions API `answers` map.
 * Produces the exact BGA check verdict structure: `{ aligned: 'YES'|'NO'|'NA', rationale, probability, confidence }`.
 */
function evaluateSingleCheck(check, answers, includeStaticChecks = false) {
  if (check.evaluationMode === 'static_web_only' && !includeStaticChecks) {
    return {
      id: check.id,
      title: check.title,
      category: check.category,
      applicable_to: check.applicable_to,
      aligned: 'NA',
      probability: null,
      confidence: 1.0,
      needsHumanReview: false,
      temporalWindow: 'n/a',
      rationale: check.naReason
    };
  }

  if (check.guardKey && answers[check.guardKey]) {
    const guardAns = answers[check.guardKey];
    const guardProb = guardAns.noul ?? 0;
    if (guardProb < 0.45) {
      return {
        id: check.id,
        title: check.title,
        category: check.category,
        applicable_to: check.applicable_to,
        aligned: 'NA',
        probability: guardProb,
        confidence: guardAns.confidence ?? (1 - guardProb),
        needsHumanReview: false,
        temporalWindow: check.temporalWindow || 'full_video',
        rationale: `Not applicable to this video (scope check '${check.guardKey}' P(yes)=${guardProb.toFixed(2)}).`
      };
    }
  }

  const ans = answers[check.questionKey];
  if (!ans) {
    return {
      id: check.id,
      title: check.title,
      category: check.category,
      applicable_to: check.applicable_to,
      aligned: 'NA',
      probability: null,
      confidence: 0,
      needsHumanReview: true,
      temporalWindow: check.temporalWindow || 'full_video',
      rationale: 'No answer returned by Decisions API for this check.'
    };
  }

  let aligned = 'YES';
  let complianceProbability = 0.5;
  let confidence = ans.confidence ?? 0.5;
  let rawDetail = '';

  if (ans.type === 'noul') {
    const pYes = ans.noul ?? 0.5;
    if (check.polarity === 'negative') {
      complianceProbability = Number((1 - pYes).toFixed(4));
      aligned = pYes >= (check.threshold ?? 0.3) ? 'NO' : 'YES';
      rawDetail = `P(violation)=${pYes.toFixed(2)}, P(compliant)=${complianceProbability.toFixed(2)}`;
    } else {
      complianceProbability = pYes;
      aligned = pYes >= (check.threshold ?? 0.5) ? 'YES' : 'NO';
      rawDetail = `P(compliant)=${pYes.toFixed(2)}`;
    }
  } else if (ans.type === 'score') {
    const maxLevel = Object.keys(ans.legend || {}).length - 1 || 2;
    const normalizedScore = maxLevel > 0 ? (ans.score ?? 0) / maxLevel : 0;
    complianceProbability = Number(normalizedScore.toFixed(4));
    aligned = normalizedScore >= (check.threshold ?? 0.5) ? 'YES' : 'NO';
    const topLevel = Object.entries(ans.probabilities || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    const levelDesc = (ans.legend && topLevel != null) ? ans.legend[topLevel] : '';
    rawDetail = `Rubric score=${(ans.score ?? 0).toFixed(2)}/${maxLevel} (${levelDesc})`;
  } else if (ans.type === 'choice') {
    complianceProbability = ans.confidence ?? 0.5;
    aligned = ans.choice === 'compliant' ? 'YES' : 'NO';
    rawDetail = `Choice=${ans.choice}`;
  }

  const needsHumanReview = confidence < 0.65;

  const defaultRationale =
    aligned === 'YES'
      ? `Complies with "${check.title}" (${rawDetail}, confidence ${(confidence * 100).toFixed(0)}%).`
      : `Does not meet "${check.title}" (${rawDetail}, confidence ${(confidence * 100).toFixed(0)}%). Rule: ${(check.prompt || '').replace(/\*\*[^*]+\*\*/g, '').trim()}`;

  return {
    id: check.id,
    title: check.title,
    category: check.category,
    applicable_to: check.applicable_to,
    prompt: check.prompt,
    aligned,
    probability: complianceProbability,
    confidence,
    needsHumanReview,
    temporalWindow: check.temporalWindow || 'full_video',
    rationale: defaultRationale
  };
}

/**
 * Optional second-stage explainer: calls Gemini Flash ONLY for failed (`NO`) or low-confidence checks
 * so the practitioner gets specific timestamps and actionable remediation suggestions.
 */
async function enrichFailedChecksWithExplanations({
  videoInputBlock,
  failedEvaluations,
  brandName,
  apiKey
}) {
  if (!failedEvaluations || failedEvaluations.length === 0) return {};

  const checkListText = failedEvaluations
    .map(
      (c, i) =>
        `${i + 1}. [id=${c.id}] (${c.brand_name || brandName}) "${c.title}" (Category: ${c.category}) — Rule: ${c.prompt}`
    )
    .join('\n');

  const prompt = `You are a Brand Governance auditor for ${brandName}.
The following brand governance checks FAILED on this video according to Gemini Decision 1.
For each check ID, inspect the video and audio and provide:
1. "rationale": 1-2 concise sentences explaining specifically what appears (or is missing) in the video/audio that caused the check to fail.
2. "timestamp": approximate timestamp or time range in "MM:SS" or "MM:SS-MM:SS" format (or "Throughout" / "End of video").
3. "suggestion": 1 concise, actionable fix the editor should make so the video passes.

Return ONLY valid JSON mapping each check ID to { "rationale", "timestamp", "suggestion" }.

Failed checks:
${checkListText}`;

  try {
    const parts = [];
    if (videoInputBlock.uri) {
      parts.push({
        file_data: {
          file_uri: videoInputBlock.uri,
          mime_type: videoInputBlock.mime_type || 'video/mp4'
        }
      });
    } else if (videoInputBlock.data) {
      parts.push({
        inline_data: {
          data: videoInputBlock.data,
          mime_type: videoInputBlock.mime_type || 'video/mp4'
        }
      });
    }
    parts.push({ text: prompt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14000);
    const res = await fetch(
      `${GEMINI_API_BASE}/models/gemini-3.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2
          }
        }),
        signal: controller.signal
      }
    ).finally(() => clearTimeout(timer));

    if (!res.ok) return {};
    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) return {};
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (_) {
    return {};
  }
}

/**
 * Evaluates a video against ONE OR MORE selected brands in a single Gemini Decisions API pass!
 * Because Gemini Decision 1 accepts up to 1,000 questions per request and bills the video tokens only once,
 * multi-brand evaluation merges all selected brands' questions into one call.
 */
async function evaluateVideoAgainstBrand({
  brandIds,
  brandId,
  videoUri,
  videoBuffer,
  mimeType = 'video/mp4',
  assetName = 'video.mp4',
  assetPath = '',
  assetId = '',
  durationSec = null,
  resolution = 'low',
  includeExplanations = true,
  apiKey
}) {
  // Normalize requested brand list (supports 1 or multiple brands)
  const requestedList = Array.isArray(brandIds) && brandIds.length > 0
    ? brandIds
    : [brandId || allBrandsCatalog.default_brand_id];

  const selectedBrands = requestedList.map(id => resolveBrandConfig(id));

  let videoBlock;
  let uploadedFile = null;

  if (videoBuffer) {
    if (videoBuffer.length <= 15 * 1024 * 1024) {
      videoBlock = {
        type: 'video',
        data: videoBuffer.toString('base64'),
        mime_type: mimeType,
        resolution
      };
    } else {
      uploadedFile = await uploadVideoToGeminiFiles(videoBuffer, mimeType, assetName, apiKey);
      videoBlock = {
        type: 'video',
        uri: uploadedFile.uri,
        mime_type: uploadedFile.mimeType,
        resolution
      };
    }
  } else if (videoUri) {
    videoBlock = {
      type: 'video',
      uri: videoUri,
      mime_type: mimeType,
      resolution
    };
  } else {
    throw new Error('Either videoBuffer or videoUri is required');
  }

  // Merge questions across all selected brands (namespaced by brand index if >1 brand)
  const mergedQuestions = {};
  for (let bIdx = 0; bIdx < selectedBrands.length; bIdx++) {
    const bConf = selectedBrands[bIdx];
    const prefix = selectedBrands.length > 1 ? `b${bIdx}_` : '';
    for (const [qKey, qVal] of Object.entries(bConf.questions)) {
      mergedQuestions[`${prefix}${qKey}`] = qVal;
    }
  }

  const contextMeta = JSON.stringify({
    asset_name: assetName,
    asset_path: assetPath,
    duration_seconds: durationSec,
    brands_evaluated: selectedBrands.map(b => b.brand_name)
  });

  const decisionResult = await callGeminiDecisionsApi({
    videoInputBlock: videoBlock,
    contextText: `Video asset metadata: ${contextMeta}`,
    questions: mergedQuestions,
    apiKey
  });

  // Unpack per-brand evaluations
  const brandReports = [];
  const allEvaluations = [];

  for (let bIdx = 0; bIdx < selectedBrands.length; bIdx++) {
    const bConf = selectedBrands[bIdx];
    const prefix = selectedBrands.length > 1 ? `b${bIdx}_` : '';

    // Slice answers for this brand
    const brandAnswers = {};
    for (const qKey of Object.keys(bConf.questions)) {
      const fullKey = `${prefix}${qKey}`;
      if (decisionResult.answers[fullKey]) {
        brandAnswers[qKey] = decisionResult.answers[fullKey];
      }
    }

    const brandEvals = bConf.checks.map(check => {
      const ev = evaluateSingleCheck(check, brandAnswers, false);
      return {
        ...ev,
        brand_id: bConf.brand_id,
        brand_name: bConf.brand_name
      };
    });

    const bPassed = brandEvals.filter(e => e.aligned === 'YES');
    const bFailed = brandEvals.filter(e => e.aligned === 'NO');
    const bNa = brandEvals.filter(e => e.aligned === 'NA');
    const bApplicable = bPassed.length + bFailed.length;
    const bScore = bApplicable > 0 ? Math.round((bPassed.length / bApplicable) * 100) : 100;

    brandReports.push({
      brand_id: bConf.brand_id,
      brand_name: bConf.brand_name,
      overall_aligned: bFailed.length === 0,
      compliance_score: bScore,
      successful_checks: bPassed.length,
      failed_checks: bFailed.length,
      not_applicable_checks: bNa.length,
      evaluations: brandEvals
    });

    allEvaluations.push(...brandEvals);
  }

  const failedList = allEvaluations.filter(e => e.aligned === 'NO');

  if (includeExplanations && failedList.length > 0) {
    const explanations = await enrichFailedChecksWithExplanations({
      videoInputBlock: videoBlock,
      failedEvaluations: failedList.slice(0, 15),
      brandName: selectedBrands.map(b => b.brand_name).join(', '),
      apiKey
    });

    for (const ev of allEvaluations) {
      const exp = explanations[ev.id];
      if (exp) {
        if (exp.rationale) ev.rationale = exp.rationale;
        if (exp.timestamp) ev.timestamp = exp.timestamp;
        if (exp.suggestion) ev.suggestion = exp.suggestion;
      }
    }
  }

  const passed = allEvaluations.filter(e => e.aligned === 'YES');
  const failed = allEvaluations.filter(e => e.aligned === 'NO');
  const notApplicable = allEvaluations.filter(e => e.aligned === 'NA');
  const applicableCount = passed.length + failed.length;
  const complianceScore =
    applicableCount > 0 ? Math.round((passed.length / applicableCount) * 100) : 100;

  const totalInputTokens = decisionResult.usage?.total_input_tokens || 0;
  const estimatedCostUsd = Number(((totalInputTokens / 1_000_000) * 0.1).toFixed(6));

  return {
    success: true,
    brand_id: selectedBrands.map(b => b.brand_id).join(','),
    brand_name: selectedBrands.map(b => b.brand_name).join(' + '),
    brands_evaluated: selectedBrands.map(b => ({
      brand_id: b.brand_id,
      brand_name: b.brand_name
    })),
    brand_reports: brandReports,
    asset: {
      assetId,
      assetPath,
      assetName,
      durationSec
    },
    overall_aligned: failed.length === 0,
    compliance_score: complianceScore,
    successful_checks: passed.length,
    failed_checks: failed.length,
    not_applicable_checks: notApplicable.length,
    human_review_count: allEvaluations.filter(e => e.needsHumanReview && e.aligned !== 'NA').length,
    telemetry: {
      model: 'gemini-decision-1',
      resolution,
      latency_ms: decisionResult.latencyMs,
      questions_evaluated: Object.keys(mergedQuestions).length,
      usage: decisionResult.usage,
      estimated_cost_usd: estimatedCostUsd
    },
    evaluations: allEvaluations
  };
}

module.exports = {
  defaultCompiled,
  allBrandsCatalog,
  resolveBrandConfig,
  uploadVideoToGeminiFiles,
  callGeminiDecisionsApi,
  evaluateSingleCheck,
  evaluateVideoAgainstBrand
};
