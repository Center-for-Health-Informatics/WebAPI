#!/usr/bin/env bash
# Sign in through CHI auth + test IdP as a persona and print a WebAPI JWT.
# The cookie jar (CHI session) is kept in secrets/session-<persona>.jar.
# Usage: eval "$(chi/devstack/session.sh developer)"  ->  $JAR $JWT
set -u
V=https://dev.lastchance.pub; P=${1:-developer}
J=${SESSION_DIR:-$HOME/Projects/WebAPI/chi/devstack/secrets}/session-$P.jar; rm -f $J
c() { curl -s -c $J -b $J "$@"; }
LOC=$(c -o /dev/null -w "%{redirect_url}" "$V/auth/login/test?RelayState=%2Fatlas%2F")
IDP=$(c "$LOC")
field() { grep -A6 "value=\"$P\"" <<<"$IDP" >/dev/null; python3 -c "
import sys,re,html
page=sys.stdin.read()
for f in re.findall(r'<form class=\"persona\".*?</form>', page, re.S):
  if 'name=\"persona\" value=\"$P\"' in f:
    print('&'.join('%s=%s'%(n, __import__('urllib.parse').parse.quote(html.unescape(v))) for n,v in re.findall(r'name=\"([^\"]+)\" value=\"([^\"]*)\"', f) if n!='action')+'&action=send'); break
" <<<"$IDP"; }
FORM=$(field)
RESP=$(c -X POST -d "$FORM" "$V/idp/sso/respond")
ACS=$(python3 -c "
import sys,re,html,urllib.parse
p=sys.stdin.read()
a=html.unescape(re.search(r'<form[^>]*action=\"([^\"]+)\"',p).group(1))
fs=re.findall(r'name=\"([^\"]+)\" value=\"([^\"]*)\"',p)
print(a); print('&'.join('%s=%s'%(n,urllib.parse.quote(html.unescape(v),safe='')) for n,v in fs))
" <<<"$RESP")
ACS_URL=$(head -1 <<<"$ACS"); ACS_BODY=$(tail -1 <<<"$ACS")
c -o /dev/null -X POST -d "$ACS_BODY" "$ACS_URL"
JWT=$(c $V/WebAPI/user/login/assertion | python3 -c 'import sys,json;print(json.load(sys.stdin)["jwt"])')
echo "JAR=$J JWT=$JWT"
