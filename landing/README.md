# Landing Page — Agency White-Label Offer

`index.html` — a single, self-contained landing page for the White-Label AI Infrastructure
License. No build step, no external assets (all CSS is inline), so it hosts anywhere static:
TinyHost, Netlify drop, GitHub Pages, Render static, etc.

## Payment links — already wired (live)

The buttons point at live Stripe payment links, verified against the account:

| Button | Link | Charges |
|---|---|---|
| "Start my license" / "Get started" | `.../6oU9AS3WGdTlaWr68D0000G` | $2,500 one-time + $1,500/month recurring |
| "Buy the codebase" | `.../bJecN4al44iL5C7bsX0000H` | $25,000 one-time |

If you ever change the pricing, update these three `href`s in `index.html`.

**Optional:** the copy references booking a 15-minute screen share. If you want a
"Book a call" button, wire it to your calendar URL the same way.

## Deploy on TinyHost (or any static host)

1. Upload `index.html` as the site's index/root file.
2. That's it — the page is fully static and self-contained.

## Notes

- Messaging matches the current offer (agency white-label, $2,500 setup + $1,500/mo, or a
  $25,000 buyout) and the outreach in `marketing/OUTREACH-CAMPAIGN.md`. It intentionally does
  **not** reuse the stale `README_SALES.md` (which describes an older 9-niche boilerplate).
- Light/dark friendly, mobile responsive.
