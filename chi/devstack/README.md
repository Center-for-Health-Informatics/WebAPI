# Dev stack: WebAPI 3 + Atlas3 behind CHI Authentication

Everything runs on studio (`studio.lastchance.pub`, 192.168.1.2). rubeus's
nginx fronts it at **https://dev.lastchance.pub**. rubeus is a Raspberry Pi and
runs nothing but nginx.

| service | where | port |
| --- | --- | --- |
| CHI Authentication | `~/Projects/auth`, native Node | 2069 |
| test SAML IdP | `~/Projects/identity`, native Node | 2053 |
| assets | `~/Projects/assets/htdocs` in `nginx:1.30-alpine` | 2063 |
| WebAPI 3 | `chi-tools.uc.edu/ohdsi-webapi:3.0.0-chi.1` | 28080 |
| Postgres 17 | volume `webapi-pgdata` | (container network only) |
| Atlas3 | `~/Projects/Atlas3/dist` in `nginx:1.30-alpine` | 28527 |

## Starting

```sh
# test IdP
cd ~/Projects/identity && HTTP_PORT=2053 HTTP_HOST=0.0.0.0 \
  BASE_URL=https://dev.lastchance.pub/idp node lib/server.js &

# CHI Authentication (settings in data/devstack.env, git-ignored)
cd ~/Projects/auth && node --env-file=data/devstack.env lib/server.js &

# assets
cd ~/Projects/assets && container run -d --name chi-assets -p 0.0.0.0:2063:80 \
  -v "$PWD/htdocs:/usr/share/nginx/html:ro" \
  -v "$PWD/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.30-alpine

# WebAPI, Postgres, Atlas3 (after `npm run build` in ~/Projects/Atlas3)
chi/devstack/up.sh
```

`up.sh` generates the Postgres password, WebAPI JWT secret and jasypt key into `secrets/`
(git-ignored) on first run. It also needs `secrets/cacerts`, a copy of JDK 21's
`cacerts` with the lastchance.pub internal root and intermediate CAs imported,
so WebAPI can fetch the JWKS over https through rubeus:

```sh
K=/opt/homebrew/opt/openjdk@21/bin/keytool
cp /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/lib/security/cacerts secrets/cacerts
security find-certificate -c "lastchance.pub Internal CA Root CA" -p > secrets/internal-root.pem
$K -importcert -noprompt -storepass changeit -keystore secrets/cacerts -alias lastchance-root -file secrets/internal-root.pem
```

## One-time setup already done

- **IdP knows auth:** `~/Projects/identity/sps/chi-auth-dev.xml` is auth's
  `/metadata` for dev.lastchance.pub.
- **auth guards the stack:** resource "OHDSI (dev)" on `dev.lastchance.pub`,
  URI roots `/atlas/` and `/WebAPI/`, open to UC and Children's sign-ins.
  Without it, `ALLOW_UNLISTED` lets the pages through signed-out and WebAPI
  sees no assertion.
- **rubeus** (`/srv/nginx`, originals in `~/nginx-backup-20261105-145108/`):
  - `snippets/auth.conf`, `idp.conf`, `assets.conf`: `work.lastchance.pub` →
    `studio.lastchance.pub`
  - `snippets/ohdsi-studio.conf`: this directory's `rubeus-ohdsi-studio.conf`
  - `conf.d/dev.conf`: `include /etc/nginx/snippets/ohdsi-studio.conf;`
  - apply with `./reload.sh`

## Signing in

Open https://dev.lastchance.pub/atlas/, sign in with the test IdP, pick a
persona. **developer** (`iretonrt`) is WebAPI admin via `SECURITY_ADMINLOGIN`;
**faculty** (`testfp`) is an ordinary user. In Atlas3 choose **CHI Sign-In**.
