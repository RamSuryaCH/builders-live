#!/usr/bin/env bash
# Tear the stack down from AWS CloudShell. See docs/teardown.md.
set -euo pipefail
cd "$(dirname "$0")/.."
# AWS_REGION wins over AWS_DEFAULT_REGION. Set both so teardown hits the Sydney stack.
export AWS_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
STACK="${STACK_NAME:-builders-live}"

read_output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region ap-southeast-2 \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true
}

BUCKET="$(read_output FrontendBucketName)"
if [[ -n "$BUCKET" && "$BUCKET" != "None" ]]; then
  echo "Emptying s3://${BUCKET}"
  aws s3 rm "s3://${BUCKET}" --recursive --region ap-southeast-2
fi

if ! command -v sam >/dev/null 2>&1; then
  python3 -m pip install --user aws-sam-cli
  export PATH="${HOME}/.local/bin:${PATH}"
fi

sam delete --stack-name "$STACK" --region ap-southeast-2 --no-prompts
echo "Stack delete started. CloudFront removal often takes several minutes."
echo "Room items also expire on their own via DynamoDB TTL if a destroy is interrupted."
