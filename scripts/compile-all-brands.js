/**
 * Compiles exported Experience Context brand checks (`data/all-brands-checks.json`)
 * into a unified multi-brand Gemini Decisions API catalog (`data/all-brands-compiled.json`
 * and `src/aem-assets-assetsview-1/actions/shared/all-brands-compiled.json`).
 *
 * All customer/tenant brand data under `data/` and `actions/shared/*-compiled*.json`
 * is gitignored so no customer brand rules are committed to source control.
 */

const fs = require('fs');
const path = require('path');

const allBrandsChecksFile = path.join(__dirname, '../data/all-brands-checks.json');
if (!fs.existsSync(allBrandsChecksFile)) {
  console.error('Missing data/all-brands-checks.json. Export your Experience Context checks first.');
  process.exit(1);
}

const allBrandsRaw = JSON.parse(fs.readFileSync(allBrandsChecksFile, 'utf8'));

// Optional detailed per-brand override compiler (gitignored if present locally)
const optionalDetailedCompiler = path.join(__dirname, 'compile-cvs-questions.js');
let detailedOverrides = {};
if (fs.existsSync(optionalDetailedCompiler)) {
  try {
    require(optionalDetailedCompiler);
    const dataDir = path.join(__dirname, '../data');
    for (const fn of fs.readdirSync(dataDir)) {
      if (fn.endsWith('-compiled-questions.json')) {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, fn), 'utf8'));
        if (parsed && parsed.brand_id) {
          detailedOverrides[parsed.brand_id] = parsed;
        }
      }
    }
  } catch (_) {}
}

// Categories that apply only to static web/display banner modules or print flyers
const STATIC_ONLY_CATEGORY_PATTERNS = [
  /^Ad Formats$/i,
  /^Module Copy$/i,
  /^Module Imagery$/i,
  /^Mobile Copy$/i,
  /^Mobile Imagery$/i,
  /^Pinterest Imagery$/i,
  /^Search Copy$/i,
  /^Copy Limits$/i,
  /^Comparison Experience$/i,
  /^Itinerary Information$/i,
  /^Offer Displays$/i,
  /^Offer Presentation$/i,
  /^Search Controls$/i,
  /^Seat Information$/i,
  /^Seat Maps$/i,
  /^Seat Pricing$/i,
  /^Shopping Displays$/i,
  /^Upgrade Displays$/i
];

const STATIC_PROMPT_KEYWORDS = [
  'consumer-facing flyers must feature a .25',
  'flyers must include editable fields',
  'screen reader content order',
  'resized to 200%',
  'redundant links',
  'campaign landing page',
  'online circular',
  'one-by banner',
  'two-by banner',
  'pencil banner',
  'navigation banner'
];

function isStaticOnlyCheck(check) {
  const cat = check.category || '';
  if (STATIC_ONLY_CATEGORY_PATTERNS.some(re => re.test(cat))) return true;
  const promptLower = `${check.title} ${check.prompt}`.toLowerCase();
  return STATIC_PROMPT_KEYWORDS.some(kw => promptLower.includes(kw));
}

function detectNegativePolarity(check) {
  const text = `${check.title} ${check.prompt}`.toLowerCase();
  return (
    text.startsWith('do not ') ||
    text.startsWith('avoid ') ||
    text.startsWith('never ') ||
    text.startsWith('no ')
  );
}

function buildQuestionForCheck(check, brandName) {
  const cleanPrompt = (check.prompt || check.title || '')
    .replace(/\*\*[^*]+\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const isNeg = detectNegativePolarity(check);

  if (isNeg) {
    return {
      polarity: 'negative',
      threshold: 0.35,
      question: {
        type: 'noul',
        instructions: `In this ${brandName} video (evaluating visual frames, on-screen text, and spoken audio), does the content violate this rule: "${cleanPrompt}"?`,
        criteria: {
          true_description: `The video violates the rule (${check.title}).`,
          false_description: `The video complies with the rule and contains no such violation.`
        }
      }
    };
  }

  return {
    polarity: 'positive',
    threshold: 0.5,
    question: {
      type: 'noul',
      instructions: `In this ${brandName} video (evaluating visual frames, on-screen text, and spoken audio), does the content satisfy this brand requirement: "${cleanPrompt}"?`,
      criteria: {
        true_description: `The video satisfies "${check.title}" (${cleanPrompt}).`,
        false_description: `The video fails or contradicts "${check.title}".`
      }
    }
  };
}

const UNIVERSAL_GUARDS = {
  guard_has_audio_speech: {
    type: 'noul',
    instructions:
      'Does the video contain spoken voiceover, dialogue, or narration in the audio track?',
    criteria: {
      true_description: 'Spoken words are audible in the audio track.',
      false_description: 'Silent audio or instrumental music/SFX only.'
    }
  },
  guard_has_onscreen_text: {
    type: 'noul',
    instructions:
      'Does any text, headline, caption, super, or call-to-action appear visually on screen in the video?',
    criteria: {
      true_description: 'Visible text or typography appears on screen.',
      false_description: 'Zero on-screen text.'
    }
  },
  guard_shows_food: {
    type: 'noul',
    instructions: 'Does the video visually depict food or beverage items?',
    criteria: {
      true_description: 'Food or drink items are shown in the video.',
      false_description: 'No food or drink items are shown.'
    }
  },
  guard_shows_people_lifestyle: {
    type: 'noul',
    instructions: 'Does the video show live-action people in lifestyle or dining scenes?',
    criteria: {
      true_description: 'Live-action people appear in the video.',
      false_description: 'Product-only shots or animation with no live-action people.'
    }
  },
  guard_shows_illustration: {
    type: 'noul',
    instructions: 'Does the video use 2D/3D vector or hand-drawn illustration graphics as a visual style?',
    criteria: {
      true_description: 'Contains vector or hand-drawn illustration art.',
      false_description: 'Live-action photography/footage without illustration graphics.'
    }
  },
  guard_shows_packaging: {
    type: 'noul',
    instructions: 'Does the video show product packaging?',
    criteria: {
      true_description: 'Product packaging appears in the video.',
      false_description: 'No product packaging is shown.'
    }
  }
};

const brandsCatalog = {};

for (const b of allBrandsRaw.brands || []) {
  if (detailedOverrides[b.brand_id]) {
    brandsCatalog[b.brand_id] = detailedOverrides[b.brand_id];
    continue;
  }

  const questions = { ...UNIVERSAL_GUARDS };
  const compiledChecks = [];

  for (const check of b.checks || []) {
    if (isStaticOnlyCheck(check)) {
      compiledChecks.push({
        id: check.id,
        title: check.title,
        category: check.category,
        applicable_to: check.applicable_to,
        prompt: check.prompt,
        evaluationMode: 'static_web_only',
        naReason: `Rule applies to static web/print layouts (${check.category}), not video assets.`
      });
      continue;
    }

    const qKey = `q_${check.id.slice(0, 8)}`;
    const built = buildQuestionForCheck(check, b.brand_name);
    questions[qKey] = built.question;

    let guardKey = null;
    const catLower = (check.category || '').toLowerCase();
    if (catLower.includes('food photography')) {
      guardKey = 'guard_shows_food';
    } else if (catLower.includes('lifestyle photography')) {
      guardKey = 'guard_shows_people_lifestyle';
    } else if (catLower.includes('illustration')) {
      guardKey = 'guard_shows_illustration';
    } else if (catLower.includes('packaging')) {
      guardKey = 'guard_shows_packaging';
    }

    compiledChecks.push({
      id: check.id,
      title: check.title,
      category: check.category,
      applicable_to: check.applicable_to,
      prompt: check.prompt,
      evaluationMode: 'gemini_decision',
      questionKey: qKey,
      guardKey,
      polarity: built.polarity,
      threshold: built.threshold,
      temporalWindow: 'full_video'
    });
  }

  const activeCount = compiledChecks.filter(c => c.evaluationMode === 'gemini_decision').length;
  const naCount = compiledChecks.filter(c => c.evaluationMode === 'static_web_only').length;

  brandsCatalog[b.brand_id] = {
    brand_id: b.brand_id,
    brand_name: b.brand_name,
    compiled_at: new Date().toISOString(),
    stats: {
      total_experience_context_checks: compiledChecks.length,
      active_video_applicable_checks: activeCount,
      static_channel_na_checks: naCount,
      unique_decisions_api_questions: Object.keys(questions).length
    },
    questions,
    checks: compiledChecks
  };
}

const firstBrandId = Object.keys(brandsCatalog)[0] || '';
const catalogOut = {
  generated_at: new Date().toISOString(),
  default_brand_id: firstBrandId,
  brands_summary: Object.values(brandsCatalog).map(b => ({
    brand_id: b.brand_id,
    brand_name: b.brand_name,
    total_checks: b.stats.total_experience_context_checks,
    video_checks: b.stats.active_video_applicable_checks,
    questions_count: b.stats.unique_decisions_api_questions
  })),
  brands: brandsCatalog
};

const out1 = path.join(__dirname, '../data/all-brands-compiled.json');
const out2 = path.join(
  __dirname,
  '../src/aem-assets-assetsview-1/actions/shared/all-brands-compiled.json'
);
fs.writeFileSync(out1, JSON.stringify(catalogOut, null, 2));
fs.writeFileSync(out2, JSON.stringify(catalogOut, null, 2));

console.log(`Compiled ${catalogOut.brands_summary.length} brands into all-brands-compiled.json`);
