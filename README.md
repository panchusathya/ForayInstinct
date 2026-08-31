<div align="center">

<img src=".github/logo.png" alt="OpenInstinct" width="420">

**A personal iMessage assistant that can use a browser like you.**

It can do your chores, book you movie tickets, or handle your groceries.
You stay in control of your passwords, credit cards and context.

It's Open Source, self-hostable, and can use any model.
One-click deploy to Vercel and get rolling.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMerit-Systems%2Fopen-instinct&project-name=open-instinct&repository-name=open-instinct&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22other%22%2C%22productSlug%22%3A%22kernel%22%2C%22integrationSlug%22%3A%22kernel%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%5D)

<img src=".github/demo.png" alt="OpenInstinct booking movie tickets over iMessage — it walks Fandango to checkout and reports the theater, showtime, seat, and total" width="640">

</div>

## Why self-host?

Personal agents are much more useful when they can sign in, book, buy and act
on your behalf. But your accounts, your passwords, are the keys to your digital
kingdom. OpenInstinct runs in your own Vercel account. Secrets are encrypted
before they touch your database and models never see them. Verify yourself by
reading the code!

## Deployment

The deploy button provisions [Kernel](https://kernel.sh) for cloud browsers and
[Neon](https://neon.tech) for Postgres. Vercel AI Gateway handles inference.
[Linq](https://linq.app) is optional and requires the setup below before
iMessage or production phone sign-in is available. Usage is billed to your
Vercel account. Set the remaining auth variables on the deployment:

```bash
BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
BETTER_AUTH_URL=https://your-host
DATABASE_URL=postgresql://user:password@host/database
DATABASE_URL_UNPOOLED=postgresql://user:password@host/database
SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

### GoForay candidate deployment

Deploy this fork independently at `https://apply.goforay.io`, with its own
Postgres database, Better Auth secret, Kernel key, and vault-encryption key.
Set `JUICEBOX_API_URL=https://api.goforay.io` and the same
`OPENINSTINCT_SHARED_SECRET` configured on JuiceBox. This shared secret signs
short-lived service calls only; it is not an ATS credential and is never sent
to a browser.

Candidates link their Better Auth account to exactly one JuiceBox candidate by
a verified email address or phone number. Linq webhooks remain attached to this
deployment at `/eve/v1/linq`; Retell voice webhooks stay with JuiceBox. The
recruiter workspace reads the resulting conversation timeline through the
signed service route, rather than copying this database.

The application database schema and versioned migrations live in `db/`. The
Drizzle application store uses `DATABASE_URL` for runtime queries; its
migration commands prefer the direct `DATABASE_URL_UNPOOLED` connection and
fall back to `DATABASE_URL` when Preview injects only the pooled URL. Run
`pnpm db:migrate` before starting against a new or upgraded local database.
Vercel uses Turbo to run the uncached migration task before its application
build. See [`db/README.md`](db/README.md) for existing-database adoption,
environment loading, and constraint-validation sequencing. Better Auth retains
its separate migration path.

Treat `SECRET_ENCRYPTION_KEY` as production key material — back it up
separately; rotating it requires re-encrypting existing values.

### Linq iMessage setup

Link the checkout to your Vercel project, create a Linq line, and attach its
connector for both app tokens and inbound webhook triggers:

```bash
vercel link
vercel connect create linq --connection-method line --name open-instinct --json
vercel connect attach <returned-connector-uid> --project <your-vercel-project> --environment production --triggers --trigger-path /eve/v1/linq --yes
vercel env add LINQ_CONNECTOR production --value <returned-connector-uid> --yes
vercel env add LINQ_PHONE_NUMBER production --value <assigned-e164-number> --yes
vercel deploy --prod
```

The create command returns the connector UID. Run
`vercel connect open <returned-connector-uid>`, copy the assigned line from the
connector dashboard in E.164 format, and use it for `LINQ_PHONE_NUMBER` when
you want to display it in the app. The Vercel Connect attachment supplies
`LINQ_CONNECTOR` to the deployment. Repeat the attachment and
environment-variable steps for preview or development if those environments
should use Linq too.

Before signing in, use that connector dashboard to add each user's phone number
under **Messaging Contacts**. Linq rejects OTP delivery and drops inbound texts
from contacts that are not on this allowlist. The
`--triggers --trigger-path /eve/v1/linq` options are also required: attaching a
connector without them permits outbound token access but does not forward
incoming messages to OpenInstinct.

#### Enable thumbs-up to apply

A thumbs-up tapback on a role card is the candidate applying to that role, but
only if Linq actually sends the reaction webhook. That subscription lives in
Linq, not in this repository, so it is not created by a deploy and its absence
is silent: the tapback simply does nothing. Check it, then enable it:

```bash
pnpm linq:reactions          # report, exits non-zero if missing
pnpm linq:reactions --apply  # subscribe
```

It asks the Vercel CLI to find the connector and mint an app-subject token, so a
logged-in `vercel` is normally the only prerequisite. Credentials are tried in
order of how likely they are to be the deployment's account: `LINQ_ACCESS_TOKEN`,
then `LINQ_CONNECTOR`, then CLI discovery, and a local `LINQ_API_KEY` only as a
last resort — the reverse of the channel's own order, because a key on a
developer's laptop is usually a personal or sandbox one. To supply a token
yourself instead:

```bash
vercel connect list                             # find the linq connector uid
LINQ_ACCESS_TOKEN=$(vercel connect token <uid> --subject app) pnpm linq:reactions
```

`--subject app` is not optional. The CLI defaults to `--subject user`, and Linq
answers a user-subject token with `401 invalid_token`, because the channel
authenticates as the app (`subject: { type: "app" }`).

The token has to belong to the account the deployment talks to. **Do not
substitute a personal Linq dashboard key for a Connect-managed line.** Connect
provisions its own Linq line, so a dashboard key authenticates successfully and
then lists a different account's subscriptions — which looks exactly like the
webhook never having been registered, even while inbound iMessages arrive
normally. `LINQ_API_KEY` is therefore honored only alongside
`LINQ_WEBHOOK_SECRET`, which is direct mode (a Linq sandbox account), matching
how the channel itself chooses credentials.

Setting `LINQ_CONNECTOR` instead lets the script mint the token itself, the same
way the channel does — but that variable is typically set only in the production
environment, so a development `vercel env pull` will not include it. The script
reads `.env.local` as well as the shell, since `vercel env pull` writes there.

If the report says these credentials list no subscriptions, check whether
inbound messages still work before treating it as an outage. If Foray replies to
a text, the subscription exists and the credentials are pointed at the wrong
account. Only if Foray does not reply is the endpoint genuinely unregistered,
which the connector attachment above fixes.

This is deliberately a one-off rather than part of `pnpm build:vercel`: it
changes live provider configuration, so running it on every deploy would make a
Linq outage fail the build.

## Google Workspace connection

OpenInstinct can use a user's Gmail, Calendar, and read-only Contacts through a
user-scoped Google OAuth grant. Vercel Connect stores and refreshes the tokens;
OpenInstinct stores only the stable user identity used to request them. Gmail
access deliberately uses `gmail.modify`, not the permanent-delete
`mail.google.com` scope.

1. In one Google Cloud project, configure the OAuth consent screen and enable
   the Gmail API, Google Calendar API, and People API.
2. Create OAuth web credentials. Add
   `https://connect.vercel.com/callback` as an authorized redirect URI, then
   download the client-secret JSON.
3. Create and attach the connector. Vercel expects top-level `clientId` and
   `clientSecret` keys, not Google's nested `web.client_id` and
   `web.client_secret` download, so the script reshapes the download into a
   private temporary file, hands it to Vercel, and deletes it on exit:

   ```bash
   scripts/setup-google-connector.sh /absolute/path/to/downloaded-client-secret.json
   ```

   On Windows, run the PowerShell counterpart instead. It needs neither bash nor
   `jq`:

   ```powershell
   .\scripts\setup-google-connector.ps1 C:\path\to\downloaded-client-secret.json
   ```

   It creates the connector, attaches it to production and preview, sets
   `GOOGLE_CONNECTOR_UID`, and prints the scope list to declare on the consent
   screen. Pass environments explicitly to narrow it, and set `CONNECTOR_NAME`
   to use a name other than `open-instinct`. Re-running reuses whatever already
   exists. Never commit either credential file.

4. Redeploy so the deployment picks up `GOOGLE_CONNECTOR_UID`. The default is
   `google/open-instinct`, which is what the script creates.

Gotchas:

- Attach the connector separately to every Vercel environment that should use
  it. A production attachment does not make preview or local development work.
- Workspace reads `Setup required` whenever the connector is missing, detached
  from that environment, or named differently from `GOOGLE_CONNECTOR_UID`. The
  deployment's runtime logs name which one: look for
  `[google-workspace] connector unavailable`. `Connect` means the connector is
  found and only the user's own grant is missing.
- The Gmail read/modify scope is restricted. A Google OAuth app in Testing mode
  only works for listed test users, and those grants expire after seven days.
  Broader distribution requires Google's OAuth verification and may require a
  security assessment.
- The scopes requested here must also be declared on the Google consent screen.
  After changing scopes or enabled APIs, disconnect and reconnect the account so
  Google issues a grant with the new access.
- The grant is keyed to the authenticated OpenInstinct user. iMessage reaches
  the same grant only when its verified phone number maps to that Better Auth
  account.
- Google Contacts search uses a provider-side lazy cache, so a contact created
  moments ago may not appear immediately.
- Sending email and creating confirmed calendar events always require approval.
  Calendar events with attendees send Google invitations.

## Local development

Docker Desktop (or another Docker Compose installation) is required. Configure
the non-database variables in `.env.example`, then:

```bash
git clone https://github.com/Merit-Systems/open-instinct.git
cd open-instinct
pnpm install
pnpm dev
```

`pnpm dev` starts PostgreSQL from `compose.yaml`, applies the committed database
migrations, and starts the application. Stopping the development process also
stops and removes the PostgreSQL container; its data remains in the
`postgres-data` volume for the next run. Run `pnpm dev:app` when intentionally
using an externally managed database instead.

Local development otherwise uses the same vault, Kernel browser, and AI Gateway
path as the Vercel deployment. Better Auth and vault encryption use stable
local-only defaults when their variables are unset; deployments still require
explicit secrets.

> [!WARNING]
> This is not software intended for production use.

---

<div align="center">

Built on [Vercel](https://vercel.com) · [Kernel](https://kernel.sh) · [Linq](https://linq.app) · [Neon](https://neon.tech)

</div>
