# Assertion provider smoke test

Checks the `security.auth.assertion` wiring against a running WebAPI, without
CHI Authentication or nginx. `sso-stub.mjs` plays the signing side: it serves a
JWKS and mints ES256 assertions on request. It is a test tool only.

```sh
cd chi/assertion-smoke && npm install && node sso-stub.mjs &   # :8777
```

Run WebAPI (container) against Postgres with:

```
SECURITY_ALLOWANONYMOUSACCESS=false
SECURITY_JWT_SECRET=<random 32+ bytes>
SECURITY_ADMINLOGIN=ada
SECURITY_AUTH_ASSERTION_ENABLED=true
SECURITY_AUTH_ASSERTION_JWKSETURI=http://<host IP as seen from the container>:8777/jwks.json
SECURITY_AUTH_ASSERTION_ISSUER=https://sso.test/auth/
SECURITY_AUTH_ASSERTION_AUDIENCE=sso.test
```

then `./check.sh <webapi IP>`. With Apple's `container`, the host is the
network gateway (192.168.64.1 by default).
