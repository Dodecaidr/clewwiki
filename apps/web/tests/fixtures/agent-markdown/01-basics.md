# Authentication service

The **auth service** issues *short-lived* tokens. See [the RFC](https://example.com/rfc) and `AuthService.login`.

## Flow

Tokens are signed with `ES256`. Refresh happens every ~~5~~ 10 minutes.
