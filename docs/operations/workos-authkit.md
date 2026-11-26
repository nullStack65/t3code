# WorkOS AuthKit for T3 Code

Use Google sign-in to give each founder their own verified T3 Code session. Configure one WorkOS application per T3 deployment. The server needs an HTTPS origin that the system browser can reach and that routes back to the same T3 server instance, including when Electron started that server.

## WorkOS Dashboard

1. Choose the intended WorkOS environment and create or select the T3 Code AuthKit application in **Applications**. Copy its Client ID and create a server API key for that application and environment.
2. Enable **Google** under **Authentication methods** for hosted AuthKit. Follow the [WorkOS Google setup](https://workos.com/docs/authkit/social-login) for the Google OAuth client if the environment requires custom Google credentials. The callback registered in Google is the one displayed by WorkOS. The T3 callback goes in WorkOS.
3. In the application's **Redirects** settings, register `https://<t3-host>/api/auth/workos/callback` as the redirect URI. Use `https://<t3-host>/pair` for the sign-in and default sign-out destinations. Replace `<t3-host>` with the actual hostname and include an explicit port if the public HTTPS origin uses one. Use exact URLs without wildcards. Electron uses the same registered public callback.
4. Enroll each founder as a separate WorkOS user with their verified Google email. Copy each user's stable `user_…` ID. If the application requires organization membership, enroll both founders in the expected organization and copy its `org_…` ID. Confirm the exact `iss` claim from this environment's AuthKit access-token profile, including any trailing slash, using the [WorkOS session docs](https://workos.com/docs/authkit/sessions). Multiple Applications use an environment issuer and a separate `client_id` claim.

## One activation step

After configuring the dashboard, inject the following Infisical bundle into the T3 **server** process environment from `vault.closura.ai` and restart the canary server with `T3CODE_WORKOS_AUTH_ENABLED=true`. Apply the bundle to the service that launches T3 when Electron starts the backend. The API key belongs only in the server environment.

| Variable                        | Value                                                           |
| ------------------------------- | --------------------------------------------------------------- |
| `T3CODE_WORKOS_AUTH_ENABLED`    | `true`                                                          |
| `T3CODE_WORKOS_API_KEY`         | WorkOS server API key                                           |
| `T3CODE_WORKOS_CLIENT_ID`       | T3 application's `client_…` ID                                  |
| `T3CODE_WORKOS_ORIGIN`          | `https://<t3-host>` with no trailing slash                      |
| `T3CODE_WORKOS_ISSUER`          | Exact signed access-token issuer from this WorkOS environment   |
| `T3CODE_WORKOS_KAMERON_USER_ID` | Kameron's WorkOS `user_…` ID                                    |
| `T3CODE_WORKOS_KAMERON_EMAIL`   | Kameron's verified Google email                                 |
| `T3CODE_WORKOS_JEFF_USER_ID`    | Jeff's WorkOS `user_…` ID                                       |
| `T3CODE_WORKOS_JEFF_EMAIL`      | Jeff's verified Google email                                    |
| `T3CODE_WORKOS_ORGANIZATION_ID` | Required for an organization-scoped deployment. Otherwise omit. |

With the flag absent, false, or the bundle incomplete, the existing sign-in behavior applies. Set the flag to `false` and restart to roll back. The server rejects previous AuthKit sessions after rollback or a change to their enrollment configuration. Configure the TLS proxy to preserve the public `Host` and forward `X-Forwarded-Proto: https`. Redact callback query strings from proxy access logs. Each OAuth transaction lives on one T3 server, so the exposed origin must reach that instance from start through completion.

## Canary checks

- In separate browser profiles, select **Sign in with Google** on `/pair` and verify both accounts produce the correct attributed sender. Existing browser sessions can use **Google sign-in** in **Settings > Connections**. Confirm an unenrolled account receives HTTP 403.
- In Electron, sign in through the system browser, then select **Finish sign-in** in T3 Code. Verify the desktop session identifies the same founder. Recheck stock mobile pairing and approved device-key access against the same environment.
- Sign out in **Settings > Connections** and verify that the local session and open RPC socket lose access. This release caps the T3 session at the earlier of the WorkOS access token's expiry and 15 minutes. Users sign in again when it expires. Sign-out revokes the T3 session. WorkOS and Google keep their own sessions. Automatic refresh, provider revocation events, and approval step-up are separate rollout work.

## External applications

Register a separate WorkOS application for each first-party service. Give that app its own client ID, exact HTTPS callback and logout URLs, access policy, signed-token verification and local session. Use a separate [WorkOS Connect OAuth application](https://workos.com/docs/authkit/connect/oauth) for an external OIDC relying party. The T3 code-exchange endpoint serves its configured application only.

Keep Cloudflare Access on `vault.closura.ai` and `internal.closura.ai`. Leave each external app's Access policy in place until its own WorkOS browser, API, and WebSocket authorization and origin protection have passed a canary.
