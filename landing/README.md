# Landing Page — Agency White-Label Offer

`index.html` — a single, self-contained landing page for the White-Label AI Infrastructure
License. No build step, no external assets (all CSS is inline), so it hosts anywhere static:
TinyHost, Netlify drop, GitHub Pages, Render static, etc.

## Before you publish

1. **Drop in your payment link.** Search `index.html` for `[PAYMENT_LINK]` (3 spots — both
   pricing buttons and the final CTA) and replace it with your live Strike/Stripe payment link.
   - The $25,000 buyout is anchor copy only — it has no checkout button. If a buyer wants it, point
     that button at a `mailto:` or calendar link instead.
2. **(Optional) add a calendar link.** The copy references booking a 15-minute screen share;
   if you want a "Book a call" button, wire it to your calendar URL the same way.

## Deploy on TinyHost (or any static host)

1. Upload `index.html` as the site's index/root file.
2. That's it — the page is fully static and self-contained.

## Notes

- Messaging matches the current offer (agency white-label, $4,000 to start then $1,500/mo,
  with the $25,000 buyout as an anchor) and the outreach in `marketing/OUTREACH-CAMPAIGN.md`. It intentionally does
  **not** reuse the stale `README_SALES.md` (which describes an older 9-niche boilerplate).
- Light/dark friendly, mobile responsive.
