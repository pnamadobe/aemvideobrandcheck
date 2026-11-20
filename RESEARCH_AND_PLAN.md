# Video Brand Check for AEM — Feasibility Research & Architecture Plan

## 0. Executive Summary

- **Feasible as a customer-deployed App Builder extension (BYO Gemini API key).**
- Brands in **AEM Experience Context** are stored at runtime as structured, versioned **context rules** (by vertical/category/segment) plus **governance checks** derived from them, each tagged `applicable_to: ["text"]` or `["image"]`. There is no native `video` evaluation surface in AEM today.
- That structure maps cleanly onto the **Google Gemini Decisions API (`gemini-decision-1`)**: each brand check compiles into one or more atomic `noul` (yes/no) or `score` (rubric) questions evaluated across a video's visual frames and audio track in a single forward prefill pass (`0` output tokens billed, `$0.10 / 1M` input tokens).

---

## 1. Architecture

### 1.1 Experience Context Data Model

When a brand guidelines PDF or URL is imported into AEM Experience Context, the Governance Agent extracts two linked structures:

1. **Experience Context Rules ("build-from" half):**
   - `design_token`: Approved brand colors (hex/RGB) and typography families.
   - `brand_voice`: Imagery, lexicon, tone, and writing-style rules.
   - `claim_guardrail`: Approved claims, prohibited claims, and substantiation requirements.
   - `market_positioning`: Brand positioning and audience rules.
2. **Governance Checks ("validate-against" half):**
   - Each check contains `id`, `title`, `prompt`, `applicable_to` (`["image"]` and/or `["text"]`), `category`, and `context_refs` linking back to the underlying Experience Context rules.

### 1.2 Compiling Experience Context Checks into Gemini Decisions Questions

```
Experience Context checks (applicable_to: image | text)
  + resolved context rules (detailed rule text, design-token hex values)
        │  compile via scripts/compile-all-brands.js
        ▼
Gemini Decisions API Question Map (up to 1,000 questions / call)
  1. Scope / Applicability Guards (noul):
     e.g., guard_has_audio_speech, guard_has_onscreen_text,
           guard_shows_food, guard_shows_people_lifestyle, guard_has_cta
     → Automatically marks non-applicable checks as aligned: "NA"
  2. Visual & Temporal Rules (noul / score):
     → Evaluated across video frames (logo lockup, color palette, text density, end-card presence)
  3. Audio & On-Screen Copy Rules (noul / score):
     → Evaluated across spoken voiceover/sonic identity AND on-screen supers simultaneously
```

### 1.3 Runtime Execution Flow in App Builder

```
AEM Assets View (Browse View ActionBar / Details View Side Panel)
  OR AEM Assets I/O Event ("Asset Processing Completed")
        │
        ▼
  App Builder Action: evaluate-video
    1. Resolve selected Experience Context brand(s) (single or multi-brand)
    2. Resolve a pre-signed Azure Blob URL for the video rendition from AEM
       (_jcr_content/renditions/cq5dam.preview.mp4 / mobile.mp4 / original)
    3. POST https://generativelanguage.googleapis.com/v1beta/decisions (model: "gemini-decision-1")
       → Evaluates all compiled questions + scope guards in one pass
    4. For failed checks (aligned === "NO"), call gemini-3.5-flash-lite to generate
       concise rationale, approximate timestamp (MM:SS), and suggested fix
    5. Write results back to AEM asset metadata via RFC-6902 JSON Patch
       (PATCH /adobe/assets/{assetId}/metadata -> xdm:score, xdm:brandScore, xdm:brandScoreNotes)
```

---

## 2. Token Budget & Cost Model

| Video Resolution | Tokens / Frame | Audio Tokens / Sec | Approx. Tokens (30s Spot + 45 Questions) | Cost per Check (`$0.10 / 1M` input tokens, `$0` output) |
|---|---:|---:|---:|---:|
| `low` / `medium` | `70` | `25` | `~8,000 – 11,000` | **`~$0.001`** |
| `high` (dense OCR) | `280` | `25` | `~14,000 – 18,000` | **`~$0.0015`** |
