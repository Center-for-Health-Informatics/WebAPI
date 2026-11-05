#!/usr/bin/env bash
# End-to-end wiring checks for the assertion provider against a running WebAPI.
set -u
W=http://$1:8080/WebAPI
S=http://127.0.0.1:8777
pass=0 fail=0
check() { # name expected actual
  if [[ "$2" == "$3" ]]; then echo "PASS $1 ($3)"; pass=$((pass+1)); else echo "FAIL $1: expected $2, got $3"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' -m 10 "$@"; }
A() { curl -s "$S/sign?$1"; }

check "providers lists assertion" "user/login/assertion" "$(curl -s $W/auth/providers | python3 -c 'import sys,json;print(",".join(p["url"] for p in json.load(sys.stdin)))')"
check "login without assertion" 401 "$(code $W/user/login/assertion)"
check "login with wrong audience" 401 "$(code -H "sso-assertion: $(A 'sub=ada&aud=evil')" $W/user/login/assertion)"
check "login with expired assertion" 401 "$(code -H "sso-assertion: $(A 'sub=ada&exp=-300')" $W/user/login/assertion)"
check "API without any credentials" 401 "$(code $W/cohortdefinition)"

JWT=$(curl -s -H "sso-assertion: $(A sub=ada)" $W/user/login/assertion | python3 -c 'import sys,json;print(json.load(sys.stdin)["jwt"])')
check "login returns a WebAPI jwt" yes "$([[ ${#JWT} -gt 40 ]] && echo yes || echo no)"

check "token + matching assertion" 200 "$(code -H "Authorization: Bearer $JWT" -H "sso-assertion: $(A sub=ada)" $W/user/me)"
check "user/me reports the login" ada "$(curl -s -H "Authorization: Bearer $JWT" -H "sso-assertion: $(A sub=ada)" $W/user/me | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["login"])')"
check "admin-login granted admin" yes "$(curl -s -H "Authorization: Bearer $JWT" -H "sso-assertion: $(A sub=ada)" $W/user/me | grep -q '"permissions":\["\*"\]' && echo yes || echo no)"
check "token without assertion" 401 "$(code -H "Authorization: Bearer $JWT" $W/user/me)"
check "token + another user's assertion" 401 "$(code -H "Authorization: Bearer $JWT" -H "sso-assertion: $(A sub=mallory)" $W/user/me)"
check "token + expired assertion" 401 "$(code -H "Authorization: Bearer $JWT" -H "sso-assertion: $(A 'sub=ada&exp=-300')" $W/user/me)"
check "token + assertion on an API endpoint" 200 "$(code -H "Authorization: Bearer $JWT" -H "sso-assertion: $(A sub=ada)" $W/cohortdefinition)"

JWT2=$(curl -s -H "sso-assertion: $(A sub=bob)" $W/user/login/assertion | python3 -c 'import sys,json;print(json.load(sys.stdin)["jwt"])')
check "non-admin denied role admin" 403 "$(code -H "Authorization: Bearer $JWT2" -H "sso-assertion: $(A sub=bob)" $W/role)"
check "admin may list roles" 200 "$(code -H "Authorization: Bearer $JWT" -H "sso-assertion: $(A sub=ada)" $W/role)"

echo "$pass passed, $fail failed"
