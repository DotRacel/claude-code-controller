#!/usr/bin/env bash
# e2e-auth.sh — get a credential for the e2e drivers. Sourced, not run.
#
# A credential is an account's server-issued token now, so the scripts can no longer agree on a
# string like 'smoke-cred' out of band. There are two ways in:
#
#   ccc_smoke_token          — read the token test/smoke-server.ts writes on startup
#   ccc_login PORT USER PASS — register (ignoring "already exists") then log in, for a real
#                              `node src/server/main.ts`, which must be started with INVITE_CODE
#
# Both echo the token on success and return non-zero with a message on stderr otherwise.

# The invite code the e2e servers are started with. Not a secret — it only ever gates a
# throwaway local server.
CCC_E2E_INVITE="${CCC_E2E_INVITE:-e2e-invite-code}"
CCC_SMOKE_TOKEN_FILE=/tmp/ccc-smoke-token

# Pull `.token` out of an auth response without assuming jq is installed.
_ccc_token_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})'; }

# $1 = seconds to wait (default 15)
ccc_smoke_token() {
  local waited=0 limit="${1:-15}"
  while [ ! -s "$CCC_SMOKE_TOKEN_FILE" ]; do
    waited=$((waited + 1))
    if [ "$waited" -gt $((limit * 2)) ]; then
      echo "no token at $CCC_SMOKE_TOKEN_FILE after ${limit}s — did smoke-server.ts start?" >&2
      return 1
    fi
    sleep 0.5
  done
  cat "$CCC_SMOKE_TOKEN_FILE"
}

# $1 = port, $2 = username, $3 = password
ccc_login() {
  local port="$1" user="$2" pass="$3" token
  # Registration is idempotent for our purposes: a 409 just means a previous run created it,
  # and the token it issued then is the one login returns now.
  curl -s -X POST "http://127.0.0.1:$port/v1/auth/register" \
    -H 'content-type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$pass\",\"invite_code\":\"$CCC_E2E_INVITE\"}" >/dev/null 2>&1
  token=$(curl -s -X POST "http://127.0.0.1:$port/v1/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$pass\"}" | _ccc_token_field)
  if [ -z "$token" ]; then
    echo "login failed for $user on :$port — is the server running with INVITE_CODE=$CCC_E2E_INVITE ?" >&2
    return 1
  fi
  echo "$token"
}
