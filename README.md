# PackPilot by Shegur's

A browser-based seller operations workspace for preparing Flipkart and Meesho thermal labels, controlling SKU economics, reconciling settlements, and securely handing finished print files to an operations team.

## Features

- Multiple-PDF label batches for Flipkart and Meesho
- Exchange-order-aware Meesho SKU and quantity detection
- 3 × 5, 4 × 4, and 4 × 6 thermal print layouts
- Optional invoice pages and packing summaries
- Account-specific default logos placed inside each marketplace label, with thermal-friendly conversion
- Account-synced default print sizes and invoice choices for Flipkart and Meesho
- Compact Meesho 3 × 5 label + invoice + store QR layout with a duplicated, full-width shipment barcode
- Prepared-output caching for immediate preview and download after processing
- A private Seller dashboard with separate Flipkart and Meesho totals and recent processing activity
- One public, app-wide label count with no seller, order, SKU, address, or file details
- Meesho store QR links matched from “Sold By” text
- Six-hour local recovery for generated print PDFs
- Flipkart SKU-level settlement and product-cost analysis
- Meesho completed-payment profit and loss from a selected order month, multiple later payment reports, and the six-month returns/RTO report, with Order/Sub Order ID matching, duplicate-payment protection, and period ad-spend deduction
- Marketplace-specific master/child SKU mapping that rolls single-quantity child labels into one packing identity while preserving multi-quantity rows
- Reusable product cost including GST, packaging, and labour/other costs saved per master SKU
- Seller invitations for Google-authenticated Operations Managers
- Private Supabase PDF desk visible only to the Seller and assigned manager
- Cloud sharing restricted to PackPilot-processed label PDFs held in the Seller's six-hour local device history
- Seller-controlled immediate deletion plus automatic six-hour expiry
- Scheduled cleanup function that removes expired PDF objects and metadata
- Firebase Google sign-in, subscriptions, role-based access, saved SKU costs, and admin access
- Admin controls for adding or reducing an exact number of subscription days
- A dedicated Super Admin session that exposes only the administration workspace

## Deploy

1. Update `firebase-config.js` if the Firebase project changes.
2. Add the deployed domain under Firebase Authentication → Settings → Authorized domains.
3. Follow `SUPABASE_SETUP.md` to connect private temporary PDF storage without Firebase Storage or Firebase Cloud Functions.
4. Publish the updated Firestore rules.
5. Deploy the website. The included `vercel.json` builds the static site into `dist/`.

To verify a production build locally, run:

```bash
npm run build
```
