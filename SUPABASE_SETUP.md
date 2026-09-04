# Supabase setup for private six-hour PDFs

PackPilot continues to use Firebase Authentication and Firestore for Google login, subscriptions, seller settings and manager invitations. Supabase stores only temporary PDFs and their access mapping.

The production website allowed by the Edge Functions is:

```text
https://packpilotin.vercel.app
```

## 1. Create the free Supabase project

1. Sign in at https://supabase.com/dashboard.
2. Create a project and keep its database password private.
3. Open **Project Settings → Data API** (called **API** in some dashboard versions).
4. Copy the **Project URL**. It looks like `https://YOUR_PROJECT_REF.supabase.co`.
5. Copy the project reference from that URL; it is the part before `.supabase.co`.

Never put a Supabase service-role key in PackPilot, Vercel, Firebase, or the browser.

## 2. Create the database tables

1. In this GitHub repository, open `supabase/schema.sql`.
2. Select the **Copy raw file** button and copy the complete SQL contents.
3. In Supabase, open **SQL Editor → New query**.
4. Paste the SQL itself and select **Run**.

Do not type or paste only `supabase/schema.sql` into SQL Editor. That is a filename, not an SQL command, and causes the `syntax error at or near "supabase"` message.

## 3. Create the private PDF bucket

1. In Supabase, open **Storage → New bucket**.
2. Name it exactly `seller-pdfs`.
3. Keep **Public bucket** turned off.
4. Set the file-size limit to `25 MB` and allow only `application/pdf` when those controls are available.

Do not add public bucket policies. The Edge Function uses Supabase's protected service role on the server and checks the signed-in seller or assigned manager before every operation.

## 4. Add the GitHub Actions secrets

The included workflow deploys the Edge Functions without installing anything on your computer.

1. Open https://github.com/vsshegur/PackPilot/settings/secrets/actions.
2. Select **New repository secret** and add each secret below.

| Secret | Where to get it |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Supabase account menu → **Account Settings → Access Tokens → Generate new token** |
| `SUPABASE_PROJECT_REF` | The reference copied in step 1 |
| `CLEANUP_SECRET` | A long random password used only by the automatic deletion job |

Enter these values directly in GitHub. Do not send them in chat or commit them to the repository. The service-role key is not needed in GitHub because Supabase supplies it automatically to its own Edge Functions.

## 5. Deploy the secure functions

1. Open https://github.com/vsshegur/PackPilot/actions.
2. Select **Deploy Supabase Functions**.
3. Select **Run workflow**, keep branch `main`, and select the green **Run workflow** button.
4. Open the new run and wait until **Configure and deploy** shows a green check.

The workflow sets:

- `FIREBASE_PROJECT_ID=labelcutter-f7eb6`
- `ALLOWED_ORIGINS=https://packpilotin.vercel.app`
- your private cleanup secret

It then deploys `pdf-gateway` and `delete-expired-pdfs` with Firebase token verification handled inside the code.

If you later use another production domain, edit `.github/workflows/deploy-supabase.yml` and add the new origin separated by a comma, then run the workflow again.

### Optional local CLI method

If you prefer to deploy from a terminal, use `npx` so a global install is not required:

```bash
npx supabase@latest login
npx supabase@latest secrets set --project-ref YOUR_PROJECT_REF FIREBASE_PROJECT_ID=labelcutter-f7eb6 ALLOWED_ORIGINS=https://packpilotin.vercel.app CLEANUP_SECRET=YOUR_LONG_RANDOM_SECRET
npx supabase@latest functions deploy pdf-gateway --project-ref YOUR_PROJECT_REF --no-verify-jwt
npx supabase@latest functions deploy delete-expired-pdfs --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

## 6. Schedule permanent deletion

1. In this repository, open `supabase/cron.sql`.
2. Copy its complete contents into a text editor.
3. Replace the project URL placeholder with your Supabase Project URL.
4. Replace the cleanup-secret placeholder with the same `CLEANUP_SECRET` value saved in GitHub.
5. Paste the edited SQL into Supabase **SQL Editor** and run it.

PackPilot stops listing a file exactly six hours after upload. The cleanup job runs every five minutes, so the stored object is permanently removed within approximately five minutes after it expires. A seller can delete their own file earlier; a manager cannot delete it.

## 7. Publish the Firestore rules

1. In this repository, open `firestore.rules` and copy its complete contents.
2. In Firebase Console, open **Firestore Database → Rules**.
3. Replace the existing rules and select **Publish**.

These rules keep each seller's data isolated and allow only that seller's assigned manager to see the seller's temporary PDF list.

## 8. Connect PackPilot to Supabase

1. Open https://packpilotin.vercel.app and sign in with the Platform Super Admin account.
2. Open **Admin**.
3. Under **Private PDF storage**, paste your Supabase Project URL.
4. Select **Connect Supabase**.

The Project URL is safe to store in Firestore; it is not a password. Never paste a Supabase service-role key into this field.

## 9. Verify the connection

1. Sign in as a Seller and invite a manager's exact Google email.
2. Process a small Meesho or Flipkart label PDF in **Label Cutter**.
3. Open **Cloud PDFs**, choose the output under **Processed on this device**, and share it.
4. Confirm the file appears with a six-hour expiry time.
5. Sign in using the assigned manager's Google account on another device. Preview and Download should work; Delete should not be shown.
6. Sign back in as the Seller and select **Delete now**. The file should immediately disappear for both accounts.

If the app reports that Supabase cannot be reached, first confirm the GitHub Actions deployment is green and that the Admin page contains the exact Project URL. In the Supabase dashboard, **Edge Functions** should list both `pdf-gateway` and `delete-expired-pdfs`.
