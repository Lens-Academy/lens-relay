# Promotion Access Message

## Goal

When a user opens `/promote` without sufficient access, Lens Editor must explain
that production promotion requires an admin access token instead of silently
showing the default editor landing view.

## Design

Add a route-specific `PromotionAccessRequired` view inside the existing Lens
Editor shell. The view uses the heading `Admin access required` and states:
`You need an admin access token to use production promotion.` It also provides a
`Return to editor` link to `/`.

The `/promote` route continues to render `PromotionPage` only when both existing
conditions are true:

- the current token grants the `canPromote` capability; and
- the token covers all folders or the Lens Edu folder.

When either condition is false, the route renders `PromotionAccessRequired`.
The backend authorization and token precedence rules remain unchanged.

## Security

The message does not explain how to mint or obtain an admin token. It reveals
only the access level already implied by the rejected action. Backend
authorization remains authoritative.

## Testing

Focused tests cover the route decision independently of the full application:

- a non-admin token receives the admin-access message;
- an admin token scoped to an unrelated folder receives the same message; and
- an eligible admin continues to receive the promotion page.

Existing promotion API and page tests remain unchanged.

## Out Of Scope

- Changing which roles may promote.
- Changing token storage or replacement behavior.
- Adding a token request or token-generation workflow.
- Changing access behavior for other protected routes.
