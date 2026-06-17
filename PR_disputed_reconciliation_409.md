# fix: disputed-total dedup drops genuine legs (finding A) — recompute headlines

## Audit finding: (A) — the de-dup silently removed a genuine transaction

The headline disputed total tied, but the **explanation was wrong** — and for a court-facing tool the explanation is part of the evidence. The exact-duplicate de-dup key was `(beneficiary | date | amount | utr)`. It omitted the **sender** and the **disputed amount**, so it collapsed rows that are *not* the same money and dropped genuine legs.

### Step 1 audit (read-only) established
- The leg the engine removed was **not** the ₹500 duplicate — it was the genuine **₹409.56** hop (`110263475064 → 702902010004986`, UTR `563707902816`, ₹1400). Its only collision was a **distinct** leg with the same src/dst/UTR/amount but disputed **₹18.64** (different layer).
- The two ₹500 legs (UTR `292427997327`) differ by timestamp; per the agreed **timestamp-significant** rule they are kept as distinct.
- UTR is **not** unique-per-transaction here (one UTR fans out to 5 different transfers), so sender + disputed must be in the key.

### Fix
`dedupeRows` now keys on `(victim_account | beneficiary_account | transaction_date | transaction_amount | disputed_amount | utr_no)` — collapsing only byte-identical duplicate ledger rows.

### Before / after (corrected truth)
| | case 32709 | case …145 |
|---|---|---|
| headline disputed | 203,114.60 → **203,524.16** | 2,187,182.22 → **2,207,182.22** |
| wrongly-dropped leg | ₹409.56 hop | genuine ₹20,000 **same-day ATM cash-out** (`50100851063711`, UTR `270324046951`) |
| duplicates removed | 1 (wrong leg) → **0** | 7 → **6** |
| other | reconUnique 153→154; lien 32,767.45→32,375.01 | same_day_cashouts 27→28; exit 533,865.23→553,865.23; cashed_out & lien unchanged |

A genuine same-day ₹20,000 cash-out in …145 — forensically significant — was being hidden by the bug and is now counted. Annexure A foots line-by-line to the corrected headline; with no exact-duplicate hop leg it states hop legs directly (adjustment 0).

### Verification
- `npx jest` → **303/303**
- `node validate_v020.js` → **exit 0** (accuracy 30/30, consistency 4/4, security 10/10, cross-artifact 121/0)

Fixtures/asserts updated to the corrected truth — **no test weakened**. `audit_recon_409.js` added as the read-only audit that established ground truth.

> ⚠️ Repo-state note: the v0.2.0 feature work was uncommitted in the working tree, so this commit also carries that in-progress body (per maintainer instruction to commit the whole working tree). The reconciliation fix is the focus. **Do not merge** — left for review.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
