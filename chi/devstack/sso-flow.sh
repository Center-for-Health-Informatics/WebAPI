#!/usr/bin/env bash
# Usage: chi/devstack/sso-flow.sh [persona]   (developer = admin, faculty = ordinary user)
# Browser-equivalent flow through rubeus: CHI auth -> test IdP -> Atlas3/WebAPI.
set -u
V=https://dev.lastchance.pub; P=${1:-developer}
J=$(mktemp); trap 'rm -f $J' EXIT
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
echo "ACS $(c -o /dev/null -w '%{http_code} -> %{redirect_url}' -X POST -d "$ACS_BODY" "$ACS_URL")"
echo "atlas page        $(c -o /dev/null -w '%{http_code}' $V/atlas/)"
echo "auth/providers    $(c $V/WebAPI/auth/providers)"
LOGIN=$(c $V/WebAPI/user/login/assertion)
echo "login/assertion   $(python3 -c 'import sys,json;d=json.load(sys.stdin);print({k:v for k,v in d.items() if k!="jwt"}, "jwt:", bool(d.get("jwt")))' <<<"$LOGIN")"
JWT=$(python3 -c 'import sys,json;print(json.load(sys.stdin).get("jwt") or "")' <<<"$LOGIN")
echo "user/me           $(c -H "Authorization: Bearer $JWT" $V/WebAPI/user/me | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["user"], "admin" if "*" in d["authz"]["permissions"] else "not admin")')"
echo "cohortdefinition  $(c -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JWT" $V/WebAPI/cohortdefinition)"
echo "role (admin only) $(c -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JWT" $V/WebAPI/role)"
# The WebAPI token alone, without the CHI session cookie, must not work:
echo "token w/o session $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JWT" $V/WebAPI/user/me) (expect 302 to sign-in)"
echo "token direct      $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JWT" http://studio.lastchance.pub:28080/WebAPI/user/me) (expect 401: no assertion)"
echo "forged header     $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $JWT" -H 'sso-assertion: forged' -H 'sso-username: iretonrt' -b $J $V/WebAPI/user/me) (client headers are overwritten by nginx)"
