# Security Policy

## Supported Versions

PyChatter is currently an active early-stage project. Security fixes should target the `master` branch unless a release branch exists.

## Reporting A Vulnerability

Please do not open a public issue for sensitive vulnerabilities.

Instead, contact the maintainer privately through the repository owner profile on GitHub. Include:

- A short description of the issue
- Steps to reproduce
- Potential impact
- Any suggested fix or mitigation

## Deployment Guidance

- Run public deployments behind HTTPS.
- Keep `server/chat.db`, `.env` files, TURN credentials, and `.db_view_token` out of git.
- Use strong unique TURN credentials.
- Restrict direct access to backend TCP and WebSocket ports when Nginx is used.
- Treat the database viewer as an admin-only diagnostic tool.
