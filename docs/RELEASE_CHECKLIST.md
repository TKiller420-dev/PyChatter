# Release Checklist

Use this before tagging or publishing a release.

## Code Health

- [ ] Run Python syntax checks.
- [ ] Run JavaScript syntax checks.
- [ ] Run the integration smoke test against a clean local server.
- [ ] Confirm no local database, env file, token, or credential is staged.

## Manual Verification

- [ ] Register a new user.
- [ ] Login with an existing user.
- [ ] Send a channel message.
- [ ] Send a direct message.
- [ ] Switch channels.
- [ ] Test moderation controls with a privileged role.
- [ ] Confirm web bridge reconnect behavior.

## Deployment

- [ ] Confirm `deploy/pychatter-server.service` paths match the target host.
- [ ] Confirm `deploy/pychatter-web.service` paths match the target host.
- [ ] Confirm Nginx proxies `/ws` to the WebSocket bridge.
- [ ] Confirm TURN settings are present for public voice/video deployments.

## Documentation

- [ ] README setup steps are current.
- [ ] Configuration changes are documented.
- [ ] Breaking protocol or database changes are called out.
