/**
 * Offline / CLI Evaluation Runner for Video Brand Governance
 *
 * Usage:
 *   GEMINI_API_KEY="AIza..." node scripts/run-local-eval.js --brand "<BrandNameOrId>" --video /path/to/video.mp4 --out data/report.json
 */

const fs = require('fs');
const path = require('path');
const {
  evaluateVideoAgainstBrand
} = require('../src/aem-assets-assetsview-1/actions/shared/gemini-decisions');

async function run() {
  const args = process.argv.slice(2);
  const videoIdx = args.indexOf('--video');
  const urlIdx = args.indexOf('--url');
  const brandIdx = args.indexOf('--brand');
  const assetPathIdx = args.indexOf('--asset-path');
  const assetIdIdx = args.indexOf('--asset-id');
  const outIdx = args.indexOf('--out');

  const videoPath = videoIdx !== -1 ? args[videoIdx + 1] : null;
  const videoUrl = urlIdx !== -1 ? args[urlIdx + 1] : null;
  const brandArg = brandIdx !== -1 ? args[brandIdx + 1] : null;
  const assetPathArg = assetPathIdx !== -1 ? args[assetPathIdx + 1] : null;
  const assetIdArg = assetIdIdx !== -1 ? args[assetIdIdx + 1] : null;
  const outArg = outIdx !== -1 ? args[outIdx + 1] : null;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Set GEMINI_API_KEY in environment to run video evaluation.');
    process.exit(1);
  }

  const videoBuffer = videoPath ? fs.readFileSync(videoPath) : null;
  const report = await evaluateVideoAgainstBrand({
    brandId: brandArg || undefined,
    videoUri: videoUrl,
    videoBuffer,
    assetName: videoPath ? path.basename(videoPath) : 'video.mp4',
    assetPath: assetPathArg || videoPath || '',
    assetId: assetIdArg || '',
    apiKey
  });

  const outFile = outArg
    ? path.resolve(outArg)
    : path.join(__dirname, '../data/evaluation-report.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`Live evaluation complete (${report.brand_name})! Score: ${report.compliance_score}% -> ${outFile}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
