# AEM Video Brand Check (`aemvideobrandcheck`)

An **Adobe Developer App Builder** UI & Runtime Extension for **Adobe Experience Manager (AEM) as a Cloud Service — Assets View** (`aem/assets/assetsview/1`) that evaluates video assets (visual frames, on-screen typography/supers, and spoken/musical audio) against **AEM Experience Context** brand governance rules using the **[Google Gemini Decisions API (`gemini-decision-1`)](https://aistudio.google.com/docs/decisions-api)**.

---

## Why This Extension Exists

In AEM Experience Context (Brand Governance), importing a brand guidelines PDF or URL extracts structured **context rules** (`design_token`, `brand_voice`, `claim_guardrail`, `market_positioning`) and derives **governance checks** from them. Today, AEM's built-in evaluator supports `text`, `image`, and `page` surfaces, but **does not evaluate video or audio assets**—and evaluating an image makes one separate LLM vision call per check.

The **Gemini Decisions API (`gemini-decision-1`)** solves both problems for video governance:
- **Single-Pass Multimodal Scoring:** Evaluates up to **1,000 independent `noul` (yes/no), `choice`, and `score` (rubric) questions** across video frames + stereo audio in a **single forward prefill pass** with **0 output tokens billed** (`$0.10 / 1M input tokens`, or **~$0.001 per video**).
- **Calibrated Probabilities & Confidence:** Returns calibrated probabilities (`0.01–0.99`) and confidence scores per check, plus scope-applicability guards (`guard_has_audio_speech`, `guard_shows_food`, `guard_has_cta`, etc.) that automatically mark non-applicable checks as `N/A`.
- **Two-Stage Remediation Explanations:** For checks that fail (`aligned: "NO"`), the extension makes a single follow-up call to `gemini-3.5-flash-lite` to produce human-readable findings, approximate video timestamps (`MM:SS`), and actionable fix suggestions.
- **Native AEM Metadata Write-Back:** Writes the compliance score and detailed per-check breakdown directly back to the AEM asset's metadata (`xdm:score`, `xdm:brandScore`, `xdm:brandscore`, and `xdm:brandScoreNotes`) via `PATCH /adobe/assets/{assetId}/metadata`.

---

## Key Features

1. **Unified AEM Assets View Extension (`aem/assets/assetsview/1`):**
   - **Browse View ActionBar Button (`Brand Check`):** Select any video asset in AEM Assets View and click **Brand Check** in the top action bar (or overflow menu) to open the Brand Check modal.
   - **Details View Side-Rail Panel (`Brand Check`):** Open an asset's Details page and click the **Brand Check** shield icon in the right side rail.
   - **Automatic Upload Trigger (`asset-event-handler`):** Non-web Runtime action ready to subscribe to AEM Assets `Asset Processing Completed` (`aem.assets.asset.processing_completed`) events.
2. **Single-Brand & Multi-Brand Evaluation:**
   - Supports any set of brands exported from AEM Experience Context (`data/all-brands-checks.json` → compiled via `scripts/compile-all-brands.js`).
   - Switch between **single-brand** dropdown mode and **multi-brand** comparison mode (evaluates multiple brands simultaneously in one Gemini Decisions API call).
   - **Remembers your last chosen brand(s)** across sessions in both browser `localStorage` and server-side `@adobe/aio-lib-state`.
3. **Admin-Only Settings Tab:**
   - Verified via AEM Assets View's `guestConnection.host.auth.getCurrentUserGroupMembership()` / `getCurrentUserProfile()`.
   - Allows administrators to configure or override the Google Gemini API key (`GEMINI_API_KEY`), adjust the video resolution token budget (`low` 70 tok/frame, `medium` 70 tok/frame, `high` 280 tok/frame for dense OCR), and toggle metadata write-back.
4. **Zero Customer Data in Source Control:**
   - All tenant/customer-exported Experience Context brand files (`data/` and `src/aem-assets-assetsview-1/actions/shared/*-compiled*.json`) and workspace credential files (`*Stage.json`, `*Production.json`, `.env`) are excluded via `.gitignore`.

---

## Architecture & Repository Structure

```
aemvideobrandcheck/
├── app.config.yaml                     # App Builder root config (aem/assets/assetsview/1 + AEM dependency)
├── package.json                        # Dependencies (@adobe/uix-guest@0.10.5, @adobe/aio-sdk, etc.)
├── RESEARCH_AND_PLAN.md                # Feasibility research, Experience Context analysis & architecture
├── scripts/
│   ├── compile-all-brands.js           # Compiles exported Experience Context brands into Decisions API schema
│   └── run-local-eval.js               # CLI runner for live video brand evaluations
└── src/aem-assets-assetsview-1/
    ├── ext.config.yaml                 # Runtime manifest (evaluate-video, get-brand-checks, asset-event-handler)
    ├── actions/
    │   ├── evaluate-video/index.js     # Web action: presigned video resolution -> Gemini Decisions -> metadata patch
    │   ├── get-brand-checks/index.js   # Web action: serves brand catalog & persists user brand preferences
    │   ├── asset-event-handler/index.js# Non-web action: handles AEM Asset Processing Completed events
    │   └── shared/
    │       ├── gemini-decisions.js     # Gemini Decisions API (v1beta/decisions) + Files API + Flash explainer
    │       └── aem-client.js           # Fast presigned Azure Blob URL resolver + RFC-6902 metadata PATCH
    └── web-src/                        # Adobe Spectrum 2 styled React UI for Assets View
        ├── index.html
        └── src/
            ├── Constants.js
            ├── index.js
            └── components/
                ├── App.js
                ├── ExtensionRegistration.js
                └── VideoBrandCheckPanel.js
```

---

## Setup & Deployment

### 1. Prerequisites
- Node.js `>=20` and Adobe I/O CLI (`npm install -g @adobe/aio-cli`)
- A **Google Gemini API Key** from [Google AI Studio (`aistudio.google.com/api-keys`)](https://aistudio.google.com/api-keys)
  - *Note:* `gemini-decision-1` (`POST https://generativelanguage.googleapis.com/v1beta/decisions`) is currently served on the Gemini Developer API (`v1beta`) via Google AI Studio.

### 2. Configure `.env`
Copy `.env.example` to `.env` and set your Gemini API key and default AEM Author URL:
```ini
AIO_runtime_namespace=<your-runtime-namespace>
AIO_runtime_auth=<your-runtime-auth>
AIO_runtime_apihost=https://adobeioruntime.net
DEFAULT_AEM_HOST=https://author-pXXXXX-eYYYYYY.adobeaemcloud.com
GEMINI_API_KEY=AIzaSy...
```

### 3. Install & Compile Brand Rules
Place your exported Experience Context brand checks JSON at `data/all-brands-checks.json` (gitignored) and run:
```bash
npm install --legacy-peer-deps
node scripts/compile-all-brands.js
```

### 4. Run Offline / CLI Evaluation
```bash
set -a && source .env && set +a
node scripts/run-local-eval.js --brand "<BrandNameOrId>" --video /path/to/video.mp4 --out data/report.json
```

### 5. Deploy to Stage & Production
```bash
# Deploy to Stage
aio app use <project>-Stage.json --no-input
aio app deploy --force-build --force-deploy

# Deploy to Production
aio app use <project>-Production.json --no-input
aio app deploy --force-build --force-deploy
```
