# Supabase setup for private six-hour PDFs

The website continues to use Firebase Authentication and Firestore for Google login, subscriptions, seller settings and manager invitations. Supabase stores only temporary PDFs and their access mapping.

## 1. Create the free Supabase project

1. Sign in at `https://supabase.com/dashboard`.
2. Create a new project and keep its database password private.
3. Open **Project Settings → API** and copy the **Project URL**. Do not place the service-role key in the website.

## 2. Create the database tables

1. Open **SQL Editor → New query**.
2. Paste the complete contents of `supabase/schema.sql`.
3. Select **Run**.

## 3. Create the private PDF bucket

1. Open **Storage → New bucket**.
2. Name it exactly `seller-pdfs`.
3. Keep **Public bucket** turned off.
4. Set the file-size limit to `25 MB` and allow only `application/pdf` when those controls are available.

Do not add public bucket policies. The Edge Function uses the protected service role on the server and performs every seller/manager permission check before accessing Storage.

## 4. Deploy the secure functions

Install the Supabase CLI, sign in, and link this folder to the new project:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

Choose a long random cleanup secret and set the server-only values. Add any other production website origin after a comma.

```bash
supabase secrets set FIREBASE_PROJECT_ID=labelcutter-f7eb6
supabase secrets set ALLOWED_ORIGINS=https://shegurs-dispatch-studio.cool-apple-1407.chatgpt.site
supabase secrets set CLEANUP_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET
supabase functions deploy pdf-gateway --no-verify-jwt
supabase functions deploy delete-expired-pdfs --no-verify-jwt
```

`pdf-gateway` does not trust anonymous requests: it verifies the Firebase ID token, Seller UID and assigned manager email itself. It also accepts cloud uploads only when their PackPilot processing metadata is valid and less than six hours old. `delete-expired-pdfs` requires the separate cleanup secret.

## 5. Schedule permanent deletion

1. Open `supabase/cron.sql`.
2. Replace the project URL placeholder.
3. Replace the cleanup-secret placeholder with the same value used in step 4.
4. Paste the edited SQL into Supabase **SQL Editor** and run it.

The app stops showing a file exactly six hours after upload. The cleanup job runs every five minutes, so the underlying file is permanently removed no later than approximately five minutes after access expires.

## 6. Publish the updated Firestore rules

In Firebase Console, open **Firestore Database → Rules**, replace the existing rules with `firestore.rules`, and select **Publish**. These rules support the renamed `seller` role, retain compatibility with existing Seller records, and allow the Platform Super Admin to save the non-secret Supabase Project URL.

Firebase Storage and Firebase Cloud Functions are no longer required for new cloud PDFs.

## 7. Connect the website

1. Open the published website and sign in using the Platform Super Admin account.
2. Select **Admin**.
3. Under **Private PDF storage**, paste the Supabase Project URL.
4. Select **Connect Supabase**.

This URL is not a password or secret. Never paste the Supabase service-role key into this field.

## 8. Test the permissions

1. Sign in as a Seller and invite a manager's exact Google email.
2. Process a small marketplace label PDF in **Label Cutter**.
3. Open **Cloud PDFs**, select that output under **Processed on this device**, and share it.
4. Sign in using the manager's Google account in another browser or device and confirm that Preview and Download work but Delete does not appear.
5. Sign back in as the Seller and select **Delete now**. Confirm that the file immediately disappears for the manager.
6. Use another uninvited account and confirm it cannot open the Seller's PDF desk.

The Platform Super Admin interface intentionally has no cross-seller PDF viewer. Anyone with direct access to the Supabase project owner account or service-role key can bypass application policies, so those credentials must remain private.
