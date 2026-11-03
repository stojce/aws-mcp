#!/usr/bin/env bash
# Sets permanent passwords for the example's test users. Passwords come from
# env vars so they never enter Terraform state or the repo:
#   TEST_PASSWORD_ALICE, TEST_PASSWORD_BOB
set -euo pipefail

cd "$(dirname "$0")/.."
POOL_ID="$(terraform output -raw user_pool_id)"
REGION="${AWS_REGION:-eu-west-1}"

set_pw() {
  local username="$1" password="$2"
  if [[ -z "$password" ]]; then
    echo "missing password for $username" >&2
    exit 1
  fi
  aws cognito-idp admin-set-user-password \
    --region "$REGION" \
    --user-pool-id "$POOL_ID" \
    --username "$username" \
    --password "$password" \
    --permanent >/dev/null
  echo "password set for $username"
}

set_pw "alice@example.com" "${TEST_PASSWORD_ALICE:-}"
set_pw "bob@example.com" "${TEST_PASSWORD_BOB:-}"
